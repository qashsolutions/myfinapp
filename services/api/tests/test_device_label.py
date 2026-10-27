from app.security.client import device_label
from tests.auth_flow import IPHONE_UA, MAC_UA


def test_labels_are_short_and_human() -> None:
    assert device_label(IPHONE_UA) == "Safari on iPhone"
    assert device_label(IPHONE_UA, standalone=True) == "Safari on iPhone · Home Screen app"
    assert device_label(MAC_UA) == "Chrome on Mac"
    assert (
        device_label("Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile Safari/537.36")
        == "Chrome on Android"
    )
    assert device_label(None) == "Browser on device"
    assert len(device_label("x" * 500, standalone=True)) <= 80
