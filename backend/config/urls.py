from django.urls import include, path

from planner.api.views import spa_index

urlpatterns = [
    path("api/", include("planner.api.urls")),
    # Client-side routes fall back to the SPA shell (assets are served by WhiteNoise).
    path("", spa_index),
]
