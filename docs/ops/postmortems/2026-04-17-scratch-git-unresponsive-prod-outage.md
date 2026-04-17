# Postmortem: Scratch Git Server Unresponsive — Production Outage

**Date:** 2026-04-17
**Duration:** ~1h 50m (9:30 AM – 11:20 AM PT)
**Severity:** High — all users impacted
**Environment:** Production
**Service:** scratch-git-2 (git microservice)

## Summary

The Scratch Git server became unresponsive in production, causing pull and publish jobs to fail and surfacing errors in the Scratch web client for all users. The daily production release pipeline also failed when attempting to deploy to GCP.

## Timeline (PT)

| Time     | Event                                                                           |
| -------- | ------------------------------------------------------------------------------- |
| ~9:30 AM | scratch-git service begins having issues (per compute instance metrics)         |
| 10:53 AM | Daily production release pipeline fails deploying scratch-git to GCP            |
| 10:55 AM | Curtis noticed the issue and reported it in Slack                               |
| 10:56 AM | Incident called. Chris assumed incident commander role                          |
| 11:10 AM | scratch-git compute instance manually stopped and restarted via the GCP console |
| 11:20 AM | Confirmed immediate problem resolved and production service restored            |

## Root Cause

A large pull job caused the scratch-git server to run out of memory and hang, becoming unresponsive. The compute instance has only 4 GB of memory, which is shared between the disk cache, operating system, and running processes. A customer Curtis was onboarding had a large amount of Attio data to pull, and processing that data exhausted available memory. The start of the outage coincided with Curtis's onboarding call with the customer.

The compute instance is not large enough to handle bigger pull jobs.

## Investigation

- Checked metrics for the scratch-git compute instance
- Identified that the scratch-git service was having issues starting around 9:30 AM PT
- Viewed the metrics dashboard and observed a massive memory spike at 9:30 AM PT, after which the GCP Ops Agent suddenly stopped reporting metrics
- Attempted to SSH into the instance via the `gcloud` CLI, but the connection was blocked
- Determined the compute instance was unrecoverable and needed to be restarted
- Restarted the pull job during investigation and observed memory climb swiftly; cancelled the job to restore service

## Impact

- **Scope:** All users
- **User experience:** Pull and publish jobs failed; errors shown in the Scratch web client
- **Release pipeline:** Daily production release pipeline failed to deploy to GCP

## Resolution

1. Stopped and restarted the scratch-git compute instance via the [GCP console](https://console.cloud.google.com/compute/instancesDetail/zones/europe-west1-b/instances/scratch-git?project=spv1eu-production).
2. SSH'd into the instance via the `gcloud` CLI to confirm the server came back online and that both the scratch-git and proxy processes were running.
3. Reran the failed scratch-git deploy job in the production pipeline to ensure the latest code was deployed.
4. Verified via the `https://api.scratch.md/service-check` endpoint that the production scratch server could reach scratch-git and that the correct build version was returned.
5. Checked `app.scratch.md` to confirm the web application was responsive and that files served by the git service were returned correctly.

## Action Items

- [x] Upsize the scratch-git compute instance to provide more memory headroom for large pull/publish jobs
- [x] Add memory utilization alerting on the scratch-git compute instance
- [x] Add an uptime/ping alert for the scratch-git service so unresponsiveness is detected automatically rather than by user report
- [x] Add an alert for absence of Ops Agent metrics on the scratch-git instance (the Ops Agent stops reporting when the instance runs out of memory, so gaps in data are themselves a signal)
- [ ] Investigate disk-cache memory usage during file-heavy scratch-git operations and optimize to reduce memory pressure
- [ ] Write a runbook for resolving a hung scratch-git server (console stop/restart, SSH verification, redeploy, service-check, app.scratch.md verification)
- [ ] Evaluate guardrails for large pull jobs (e.g. size thresholds, chunking, backpressure) to prevent a single customer's data volume from taking down the service

## Lessons Learned

- The scratch-git compute instance was not sized large enough and was susceptible to running out of memory during large git operations (pull or publish)
- The compute instance did not have any memory alerts configured, so the out-of-memory condition was not caught proactively
- There were no ping/uptime alerts for the scratch-git service — it was unresponsive for over an hour before being discovered by a user
- The GCP Ops Agent stops reporting when the instance runs out of memory, so we need a separate alert on the absence of metrics data as an outage signal
- The compute instance counts disk cache as part of memory usage, and scratch-git's file-heavy operations consume a large amount of disk cache; this will need further optimization
- There were no runbooks for how to resolve a hung scratch-git server, so the team had to improvise recovery steps during the incident
- We need a smooth way to trigger an incident update on the Pulsetic.com status page
