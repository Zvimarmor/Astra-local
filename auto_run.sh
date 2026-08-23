#!/bin/bash

# נתיב לפרויקט
PROJECT_DIR="/Users/zvis_server/MyProjects/DroneSimulator"
cd "$PROJECT_DIR" || exit 1

# הפרומפט שיוזן לקלוד בכל הרצה
PROMPT="Act as a Principal Game Engineer, Graphics Developer, and QA Specialist.
Inspect and continuously enhance the Godot 4 FPV Drone Simulator in this directory.

Priorities:
1. Run headless tests (godot --headless --path . res://tests/validation.tscn), find any bugs/edge cases, and fix them.
2. If no bugs exist, add high-value gameplay features (audio synth, OSD stats, high scores, new target routes).
3. If no features remain, push Godot 4 graphics to maximum realism (PBR shaders, particles, volumetric fog, FPV camera shader).

Work 100% autonomously without pausing for input. Update AUTONOMOUS_PROGRESS.md with your progress."

echo "Starting Autonomous Claude Code Loop..."

while true; do
    echo "=================================================="
    echo "[$(date)] Starting Claude Code session..."
    echo "=================================================="

    # הרצת קלוד קוד במימשק לא-אינטראקטיבי
    claude --dangerously-skip-permissions -p "$PROMPT"

    # ברגע שקלוד יצא (בגלל Rate Limit, סיום משימה, או חריגת טוקנים)
    echo "=================================================="
    echo "[$(date)] Session ended or Rate Limit reached."
    echo "Sleeping for 5 hours (18,000 seconds)..."
    echo "=================================================="

    # השהייה של 5 שעות
    sleep 18000
done

