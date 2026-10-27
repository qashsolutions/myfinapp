"""S3-compatible object storage. Holds ciphertext backup blobs only.

The server never sees a key that can decrypt them (docs/spec.md "End-to-end encrypted
backup"). Statements and receipt photos never reach this bucket, or any server.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.config import get_settings


@lru_cache
def get_s3() -> Any:
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint_url,
        region_name=s.s3_region,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key.get_secret_value(),
        config=Config(
            connect_timeout=2,
            read_timeout=5,
            retries={"max_attempts": 2},
            s3={"addressing_style": "path"},  # MinIO and most self-hosted stores
        ),
    )


def bucket_exists() -> bool:
    try:
        get_s3().head_bucket(Bucket=get_settings().s3_bucket)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code in {"404", "NoSuchBucket", "NotFound"}:
            return False
        raise
    return True


def ensure_bucket() -> bool:
    """Create the configured bucket if it is missing. Returns True when it was created.

    Development and tests only: production buckets are provisioned out of band with
    encryption at rest and no public access.
    """
    s = get_settings()
    if s.is_prod:
        raise RuntimeError(
            "ensure_bucket is for dev and test; provision production storage out of band"
        )
    if bucket_exists():
        return False
    kwargs: dict[str, Any] = {"Bucket": s.s3_bucket}
    if s.s3_region != "us-east-1":
        kwargs["CreateBucketConfiguration"] = {"LocationConstraint": s.s3_region}
    get_s3().create_bucket(**kwargs)
    return True
