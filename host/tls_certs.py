"""
Self-signed LAN TLS certificate helper for the optional --https mode.

Generates host/certs/cert.pem + key.pem with SAN = DNS:localhost, IP:127.0.0.1
and IP:<lan_ip> (required by iOS Safari). Uses `cryptography` when installed,
otherwise falls back to an `openssl` subprocess.
"""

import datetime
import ipaddress
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

CERT_VALID_DAYS = 365   # Apple requires < 398 days for TLS server certs


def _default_certs_dir() -> Path:
    return Path(__file__).resolve().parent / "certs"


def _parse_ip(value: str):
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def _san_lists(lan_ip: str) -> Tuple[List[str], List[str]]:
    """Return (dns_names, ip_strings) to embed in the SAN extension."""
    dns = ["localhost"]
    ips = ["127.0.0.1"]
    if lan_ip:
        if _parse_ip(lan_ip) is not None:
            if lan_ip not in ips:
                ips.append(str(_parse_ip(lan_ip)))
        elif lan_ip not in dns:
            dns.append(lan_ip)
    return dns, ips


def _read_cert_info(cert_path: Path):
    """Return (dns_set, ip_set, not_after_epoch) for a PEM cert."""
    try:
        from cryptography import x509
        from cryptography.x509.oid import ExtensionOID

        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        try:
            san = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
            dns = set(san.get_values_for_type(x509.DNSName))
            ips = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
        except x509.ExtensionNotFound:
            dns, ips = set(), set()
        try:
            not_after = cert.not_valid_after_utc
        except AttributeError:
            not_after = cert.not_valid_after.replace(tzinfo=datetime.timezone.utc)
        return dns, ips, not_after.timestamp()
    except ImportError:
        info = ssl._ssl._test_decode_cert(str(cert_path))
        sans = info.get("subjectAltName", ())
        dns = {v for k, v in sans if k == "DNS"}
        ips = {str(_parse_ip(v) or v) for k, v in sans if k == "IP Address"}
        return dns, ips, ssl.cert_time_to_seconds(info["notAfter"])


def cert_has_required_sans(cert_path: Path, key_path: Path, lan_ip: str) -> bool:
    """True when the existing cert/key pair is valid, unexpired and covers localhost + lan_ip."""
    try:
        if not cert_path.is_file() or not key_path.is_file():
            return False
        if cert_path.stat().st_size == 0 or key_path.stat().st_size == 0:
            return False
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(str(cert_path), str(key_path))

        dns, ips, not_after = _read_cert_info(cert_path)
        if not_after - datetime.datetime.now(datetime.timezone.utc).timestamp() < 86400:
            return False
        if "localhost" not in dns:
            return False
        if lan_ip:
            parsed = _parse_ip(lan_ip)
            if parsed is not None:
                if str(parsed) not in ips:
                    return False
            elif lan_ip not in dns:
                return False
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------
def _generate_with_cryptography(cert_path: Path, key_path: Path, lan_ip: str) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    dns, ips = _san_lists(lan_ip)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cn = lan_ip or "localhost"
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "E-Controller Local LAN"),
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    san = [x509.DNSName(d) for d in dns] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=CERT_VALID_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, key_encipherment=True, content_commitment=False,
            data_encipherment=False, key_agreement=False, key_cert_sign=False,
            crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption()))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def _openssl_candidates() -> List[str]:
    cands: List[str] = []
    if sys.platform == "win32":
        cands += [
            r"C:\Program Files\Git\mingw64\bin\openssl.exe",
            r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
            r"C:\Program Files\OpenSSL\bin\openssl.exe",
        ]
    found = shutil.which("openssl")
    if found:
        cands.append(found)
    if sys.platform == "win32":
        cands.append(r"C:\Program Files\Git\usr\bin\openssl.exe")
    seen, out = set(), []
    for c in cands:
        if c.lower() not in seen and os.path.isfile(c):
            seen.add(c.lower())
            out.append(c)
    return out


def _generate_with_openssl(cert_path: Path, key_path: Path, lan_ip: str) -> None:
    dns, ips = _san_lists(lan_ip)
    san = ",".join([f"DNS:{d}" for d in dns] + [f"IP:{i}" for i in ips])
    cn = lan_ip or "localhost"
    cnf = (
        "[req]\n"
        "distinguished_name = dn\n"
        "x509_extensions = v3_ext\n"
        "prompt = no\n"
        "[dn]\n"
        "O = E-Controller Local LAN\n"
        f"CN = {cn}\n"
        "[v3_ext]\n"
        "basicConstraints = critical,CA:FALSE\n"
        "keyUsage = critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage = serverAuth\n"
        f"subjectAltName = {san}\n"
    )
    errors: List[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        cnf_path = Path(tmp) / "openssl.cnf"
        cnf_path.write_text(cnf, encoding="ascii")
        for exe in _openssl_candidates():
            try:
                subprocess.run(
                    [exe, "req", "-x509", "-newkey", "rsa:2048", "-sha256",
                     "-days", str(CERT_VALID_DAYS), "-nodes",
                     "-keyout", str(key_path), "-out", str(cert_path),
                     "-config", str(cnf_path), "-extensions", "v3_ext"],
                    check=True, capture_output=True, text=True, timeout=30,
                )
                return
            except Exception as exc:
                errors.append(f"{exe}: {exc}")
    raise RuntimeError("openssl failed: " + ("; ".join(errors) if errors else "no openssl binary found"))


def ensure_lan_certificate(lan_ip: str, certs_dir: Optional[Path] = None) -> Tuple[Path, Path, bool]:
    """Return (cert_path, key_path, created). Regenerates when missing or SAN lacks lan_ip."""
    certs_dir = Path(certs_dir) if certs_dir else _default_certs_dir()
    cert_path = certs_dir / "cert.pem"
    key_path = certs_dir / "key.pem"

    if cert_has_required_sans(cert_path, key_path, lan_ip):
        return cert_path, key_path, False

    certs_dir.mkdir(parents=True, exist_ok=True)
    try:
        _generate_with_cryptography(cert_path, key_path, lan_ip)
    except ImportError:
        try:
            _generate_with_openssl(cert_path, key_path, lan_ip)
        except RuntimeError as exc:
            raise RuntimeError(
                f"{exc}. Install the `cryptography` package (pip install cryptography) "
                "or OpenSSL so a self-signed certificate can be generated."
            ) from exc
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass
    return cert_path, key_path, True


def build_ssl_context(cert_path: Path, key_path: Path) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    return ctx
