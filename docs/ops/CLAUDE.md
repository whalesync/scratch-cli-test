# Overview

This folder is for all documentation related to operating Scratch from a technical level:

- runbooks for resolving issues
- postmortems to track incidents
- plans related to proposed structure changes
- architectural designs and proposals
- configuring development environments and engineering workstation tools

# PLANS

- Plans should include the timestamp when they are first created in YYYY-MM-DD format
- Plans should contain
  - problem statement
  - GCP environments and projects involved
  - summaries of the change
  - The user who initially generated the plan use git username
  - key decisions made
  - diagrams related to the system or infrastructure
  - any relevant operation examples like setup and examples
- Once a plan is fully implemented it should be moved to the `resolved` folder
- Ops plans will become long term artificts that describe why infrastructure has changed

# Important

- NEVER try to run gcloud CLI commands unless explicity requested by the user
