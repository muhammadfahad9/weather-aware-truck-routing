"""Test settings: production settings with a throwaway secret key."""

import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-not-secret")

from .settings import *  # noqa: F403
