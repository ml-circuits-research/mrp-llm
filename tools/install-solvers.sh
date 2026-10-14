#!/usr/bin/env bash
set -euo pipefail
# Optional host-level installation. Read before running; requires sudo.
sudo apt-get update
sudo apt-get install -y swi-prolog-nox z3
swipl --version
z3 --version
