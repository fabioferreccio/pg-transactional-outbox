# 060 — Incident and Runbook Rules

> **RFC 2119 Normative Language**: The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Incident Classification

### RULE-060-001: Severity Levels

Incidents MUST be classified by severity:

| Severity | Definition | Response SLA | Examples |
|----------|------------|--------------|----------|
| P1 Critical | Data loss, complete outage | 15 min | Queue blocked, partitions missing |
| P2 High | Major degradation | 1 hour | Worker crash, DLE spike |
| P3 Medium | Minor impact | 4 hours | Performance anomaly |
| P4 Low | No immediate impact | Next business day | Cleanup needed |

### RULE-060-002: Automatic Escalation

Incidents MUST escalate automatically:

| Time Unacknowledged | Escalation |
|---------------------|------------|
| 15 min | Page secondary on-call |
| 30 min | Page team lead |
| 1 hour | Page engineering manager |

### RULE-060-003: Incident Ownership

Every incident MUST have:

- Assigned owner (individual)
- Escalation path
- Communication channel

Unowned incidents are **PROHIBITED**.

---

## 2. Runbook Requirements

### RULE-060-010: Runbook Coverage

Every critical symptom MUST have a runbook:

| Symptom | Runbook Required |
|---------|-----------------|
| Queue stall (oldest pending > 5 min) | ✅ |
| Worker not processing | ✅ |
| DLE accumulation | ✅ |
| Database lock contention | ✅ |
| WAL disk exhaustion | ✅ |
| Partition missing | ✅ |
| Autovacuum starvation | ✅ |

### RULE-060-011: Runbook Structure

Every runbook MUST contain:

```markdown
# [Symptom Name]

## Detection
- How to identify the issue
- Key metrics/logs to check

## Impact
- What is affected
- Severity classification

## Diagnosis
- Step-by-step investigation
- Common causes

## Resolution
- Immediate mitigation
- Permanent fix

## Verification
- How to confirm resolution
- Post-incident checks

## Prevention
- How to prevent recurrence
```

### RULE-060-012: Runbook Maintenance

Runbooks MUST be:

- Reviewed quarterly
- Updated after every incident
- Tested in non-production annually

Stale runbooks (> 6 months unchanged) MUST be reviewed.

---

## 3. Emergency Procedures

### RULE-060-020: Emergency Access

Emergency database access MUST:

1. Be role-based (no shared credentials)
2. Require MFA
3. Be time-limited (max 4 hours)
4. Be fully logged

### RULE-060-021: Safe Emergency Commands

The following commands are PRE-APPROVED for emergencies:

```sql
-- Recover stale processing events
UPDATE outbox SET status = 'PENDING', locked_until = NULL
WHERE status = 'PROCESSING' AND locked_until < NOW();

-- Force partition creation
SELECT partman.run_maintenance('public.outbox');

-- Manual checkpoint
CHECKPOINT;
```

### RULE-060-022: Dangerous Commands

The following commands REQUIRE explicit approval:

| Command | Approval Required |
|---------|-------------------|
| `DELETE FROM outbox` | P1 + 2 approvers |
| `TRUNCATE` | P1 + VP Engineering |
| `DROP TABLE/PARTITION` | P1 + VP Engineering |
| `pg_terminate_backend` | P2 + Team Lead |
| Schema modifications | Change Advisory Board |

---

## 4. Database Interventions

### RULE-060-030: Audit Trail

All manual database operations MUST be:

1. Logged with operator identity
2. Logged with timestamp
3. Logged with command executed
4. Logged with rows affected

### RULE-060-031: Pre-Intervention Checklist

Before any intervention:

- [ ] Incident ticket created
- [ ] Approvals obtained (if required)
- [ ] Backup verified (for destructive ops)
- [ ] Rollback plan documented
- [ ] Monitoring in place

### RULE-060-032: Post-Intervention Verification

After intervention:

- [ ] Verify intended effect
- [ ] Check for collateral impact
- [ ] Update incident ticket
- [ ] Notify stakeholders

---

## 5. On-Call Requirements

### RULE-060-040: On-Call Rotation

On-call rotation MUST:

- Have primary and secondary
- Rotate weekly (minimum)
- Include handoff meetings
- Document known issues

### RULE-060-041: On-Call Tooling

On-call engineers MUST have:

- [ ] Database read access
- [ ] Worker restart capability
- [ ] Metric dashboards
- [ ] Log access
- [ ] Runbook access
- [ ] Communication channels

### RULE-060-042: On-Call Escalation

On-call engineers MUST escalate when:

- Issue exceeds expertise
- Response SLA at risk
- Multiple simultaneous incidents
- Uncertainty about action

---

## 6. Post-Incident Process

### RULE-060-050: Post-Mortem Required

P1 and P2 incidents MUST have post-mortems within 5 business days.

### RULE-060-051: Post-Mortem Content

Post-mortems MUST include:

```markdown
# Incident: [Title]

## Summary
- Date/Time: 
- Duration:
- Severity:
- Impact:

## Timeline
- HH:MM - Event
- HH:MM - Event

## Root Cause

## Resolution

## Action Items
- [ ] Item (Owner, Due Date)

## Lessons Learned
```

### RULE-060-052: Blameless Culture

Post-mortems MUST be:

- Blameless (focus on systems, not individuals)
- Constructive (identify improvements)
- Shared (team-wide visibility)

---

## 7. Prohibitions

### RULE-060-060: No Undocumented Interventions

Manual database operations without documentation are **PROHIBITED**.

### RULE-060-061: No Cowboy Fixes

Production changes without:
- Incident ticket
- Approval (if required)
- Rollback plan

are **PROHIBITED**.

### RULE-060-062: No Ignored Incidents

Incidents MUST NOT be closed without:
- Root cause identified
- Resolution documented
- Follow-up actions tracked

---

## References

- [Google SRE Book - Incident Management](https://sre.google/sre-book/managing-incidents/)
- [Blameless Post-Mortems](https://www.atlassian.com/incident-management/postmortem/blameless)
