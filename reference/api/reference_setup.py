import os

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command

from care.users.api.viewsets.plug_config import PlugConfigViewset
from care.users.models import PlugConfig

# care's demo data creates care-admin, so it is only loaded into a fresh database.
if not get_user_model().objects.filter(username="care-admin").exists():
    call_command("load_fixtures")

# The web container serves the plug's files under /plugs/abdm/, clear of the /abdm/ routes it
# adds to care_fe. care_fe loads it from url and its translations from localPath; without
# localPath it reads /locale/, care_fe's own.
PlugConfig.objects.update_or_create(
    slug="abdm",
    defaults={
        "meta": {
            "url": f"{os.environ['REFERENCE_URL']}/plugs/abdm/assets/remoteEntry.js",
            "localPath": "/plugs/abdm",
            "name": "care_abdm_fe",
            "plug": "abdm",
        }
    },
)
# CARE caches its plug config list and clears it only on changes made through its API.
cache.delete(PlugConfigViewset.cache_key)

print(f"CARE is ready at {os.environ['REFERENCE_URL']}")  # noqa: T201
