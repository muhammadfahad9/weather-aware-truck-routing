from __future__ import annotations

import json
from pathlib import Path

from django.core.management import call_command


def test_export_fixtures_writes_plan_and_heatmap(tmp_path: Path) -> None:
    call_command("export_fixtures", str(tmp_path))
    plan = json.loads((tmp_path / "plan.json").read_text())
    heatmap = json.loads((tmp_path / "heatmap.json").read_text())
    assert len(plan["routes"]) == 3
    assert plan["weather"]["simulated"] is True
    assert heatmap["frames"] >= 13
    assert len(heatmap["fields"]["wind"]) == heatmap["frames"] * len(heatmap["cells"])
