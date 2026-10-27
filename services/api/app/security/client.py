from __future__ import annotations

from fastapi import Request

from app.config import get_settings


def client_ip(request: Request) -> str:
    """The caller's IP. Proxy headers are trusted only when STACKD_TRUST_PROXY_HEADERS is on.

    Behind CloudFront the viewer's address is `CloudFront-Viewer-Address` ("ip:port", set by
    CloudFront and never taken from the client); the first X-Forwarded-For entry is whatever the
    client sent, so it is only the fallback (local proxies and tests)."""
    if get_settings().trust_proxy_headers:
        viewer = request.headers.get("cloudfront-viewer-address")
        if viewer and ":" in viewer:
            return viewer.rsplit(":", 1)[0].strip("[]")
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


_BROWSERS = (
    ("Edg/", "Edge"),
    ("OPR/", "Opera"),
    ("Firefox/", "Firefox"),
    ("Chrome/", "Chrome"),
    ("Safari/", "Safari"),
)
_DEVICES = (
    ("iPhone", "iPhone"),
    ("iPad", "iPad"),
    ("Android", "Android"),
    ("Macintosh", "Mac"),
    ("Windows", "Windows"),
    ("CrOS", "Chromebook"),
    ("Linux", "Linux"),
)


def device_label(user_agent: str | None, *, standalone: bool = False) -> str:
    """A short, human label for the Active devices list: "Safari on iPhone · Home Screen app"."""
    ua = user_agent or ""
    browser = next((name for needle, name in _BROWSERS if needle in ua), "Browser")
    device = next((name for needle, name in _DEVICES if needle in ua), "device")
    label = f"{browser} on {device}"
    if standalone:
        label += " · Home Screen app"
    return label[:80]
