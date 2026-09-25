# Laundry Color Scanner

This repository is the shared project that Claude Code will implement. It currently contains the technical design, not a second application.

Start with [the implementation blueprint](docs/BLUEPRINT.md). The authoritative seed palette is [colors.json](spec/colors.json); its reproducible generator and RGB → Lab conversion are in [generate-colors.mjs](spec/generate-colors.mjs).

All detection thresholds are initial engineering defaults awaiting the validation described in the blueprint. Color sorting does not establish dye fastness or replace a garment's care label.
