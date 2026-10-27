"""Cross-site request forgery guard for cookie sessions.

The cookie is SameSite=Lax, every state change is a JSON POST or DELETE, and this dependency
refuses requests the browser marks as cross-site or whose Origin is not ours. Non-browser
clients (tests, curl) send neither header and are allowed; they have no ambient cookie.
"""

from __future__ import annotations

from fastapi import HTTPException, Request, status

from app.config import get_settings

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def same_site_only(request: Request) -> None:
    if request.method in SAFE_METHODS:
        return
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site == "cross-site":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="cross_site")
    origin = request.headers.get("origin")
    if origin is None:
        return
    own = f"{request.url.scheme}://{request.url.netloc}"
    if origin not in get_settings().origins and origin != own:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="cross_site")
