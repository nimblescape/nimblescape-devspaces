# Change log

Each section lists the changes of one released version. The release workflow
takes the section of a version as the notes of its GitHub release.

## 0.2.0

The containers and the volume of Devspaces on a Docker engine have clearer names: the worker of a window is devspace-worker-<12 characters> (was devspace-channel-...), and the Monitor (was Session Monitor) is the container and volume devspace-monitor (was devspace-session-monitor), as its image devspace-monitor. The new Monitor starts with an empty volume; remove an old devspace-session-monitor container and volume by hand.

## 0.1.8

Maintenance release: CI runs the unit tests also as root, so the tests of the helper scripts that need root run before each release; the extension behaves as in 0.1.7.

## 0.1.7

Maintenance release: the version commit reaches main only after CI passed, and a dry run tests a release without a change; the extension behaves as in 0.1.6.

## 0.1.6

Maintenance release: the workflow "Release" created this version commit; the extension behaves as in 0.1.5.

## 0.1.5

Maintenance release: a manual start of the workflow "Release" sets the
version, creates the tag and publishes the release; the extension behaves as
in 0.1.3.

## 0.1.3

Maintenance release: the release publishes the package that CI tested and
built; the extension behaves as in 0.1.1.

## 0.1.1

Maintenance release: the test configuration and the contribution guide
changed; the extension behaves as in 0.1.0.

## 0.1.0

Initial release.

---

© 2026 Hannes Stauss (scalarion@nimblescape.com) ·
[MIT License](https://github.com/nimblescape/nimblescape-devspaces/blob/main/LICENSE).
