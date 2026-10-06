#!/bin/sh
# Deliberately does NOT run `ezcorp install`: package scripts run as root, and
# EZCorp installs per user, under rootless Podman, in that user's home. It
# also must never answer the extension-runner question on anyone's behalf.
echo ""
echo "EZCorp is installed. To start it, open EZCorp from your applications"
echo "menu, or run:  ezcorp launch"
echo ""
