# 070 — Compliance and Legal Rules

> **RFC 2119 Normative Language**: The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Data Classification

### RULE-070-001: Payload Classification Required

Every event type MUST be classified:

| Classification | Description | Examples |
|----------------|-------------|----------|
| Public | No restrictions | Product catalog updates |
| Internal | Business sensitive | Order totals, inventory |
| Confidential | Requires protection | Customer names, addresses |
| Restricted | Maximum protection | Payment data, health records |

### RULE-070-002: PII Identification

Personally Identifiable Information (PII) MUST be:

- Identified in payload schema documentation
- Tagged with `pii: true` in metadata
- Subject to additional retention controls

PII fields include:
- Names, addresses, phone numbers
- Email addresses
- Government IDs
- Financial account numbers
- Health information

### RULE-070-003: Data Inventory

A data inventory MUST exist documenting:

| Field | Requirement |
|-------|-------------|
| Event type | Name and version |
| PII fields | List of fields containing PII |
| Retention | How long data is kept |
| Legal basis | Why data is processed (GDPR) |
| Data controller | Responsible party |

---

## 2. Retention Requirements

### RULE-070-010: Legal Retention Matrix

Retention MUST comply with applicable regulations:

| Regulation | Data Type | Minimum Retention | Maximum (if PII) |
|------------|-----------|-------------------|------------------|
| SOX | Financial records | 7 years | - |
| HIPAA | Health records (ePHI) | 6 years | - |
| PCI DSS | Cardholder data | 1 year | Minimize |
| GDPR | Personal data | As needed | Delete when unnecessary |
| LGPD | Personal data | As needed | Delete when unnecessary |

### RULE-070-011: Retention Policy Documentation

Every event type MUST have documented:

```yaml
event_type: OrderCreated
retention:
  hot: 30 days
  cold: 7 years
  legal_basis: "Contract performance, SOX compliance"
  deletable: false  # Required for audit
```

### RULE-070-012: Retention Enforcement

Retention policies MUST be:

- Automated (no manual deletion required)
- Auditable (logs of what was deleted/archived)
- Verified quarterly

---

## 3. Right to Erasure (GDPR/LGPD)

### RULE-070-020: Erasure Support Required

The system MUST support data subject erasure requests.

### RULE-070-021: Crypto-Shredding

For event sourcing compatibility, crypto-shredding MUST be used:

```typescript
// Each user has unique encryption key
const userKey = await kms.getKey({ userId });
const encryptedPayload = encrypt(payload, userKey);

// Erasure = destroy key
await kms.deleteKey({ userId });
// Events become unreadable
```

### RULE-070-022: Erasure Scope

Erasure MUST cover:

| Location | Action |
|----------|--------|
| Hot partitions | Crypto-shred or delete |
| Cold archives | Crypto-shred (key deletion) |
| Backups | Document retention period |
| Worker caches | Clear on restart |
| Logs | Anonymize or TTL |

### RULE-070-023: Erasure Timeline

Erasure requests MUST be completed within:

| Regulation | Timeline |
|------------|----------|
| GDPR | 30 days (extendable to 90) |
| LGPD | 15 days |

### RULE-070-024: Erasure Audit Trail

Erasure MUST be logged:

```json
{
  "action": "data_erasure",
  "subject_id": "user-123",
  "timestamp": "2024-02-07T12:00:00Z",
  "method": "crypto_shred",
  "key_destroyed": true,
  "operator": "system",
  "request_id": "DSR-456"
}
```

---

## 4. Anonymization

### RULE-070-030: Anonymization for Analytics

Events retained for analytics MUST be anonymized:

- Remove direct identifiers (names, emails)
- Replace with pseudonyms or hashes
- Aggregate where possible

### RULE-070-031: Irreversibility

Anonymization MUST be irreversible:

- No lookup tables mapping pseudonyms to identities
- Aggregation level prevents individual identification
- k-anonymity (k ≥ 5) for any combination

---

## 5. Access Controls

### RULE-070-040: Principle of Least Privilege

Access to event data MUST follow least privilege:

| Role | Access Level |
|------|--------------|
| Worker service | Read pending, update status |
| Admin | Full read, limited write |
| Audit | Read-only, full history |
| Developer | Non-production only |

### RULE-070-041: Access Logging

All access to PII events MUST be logged:

- Who accessed
- When accessed
- What was accessed
- From where

### RULE-070-042: Production Data Prohibition

Production PII data MUST NOT be used in:

- Development environments
- Testing (use synthetic data)
- Training materials
- External sharing

---

## 6. Audit Requirements

### RULE-070-050: Audit Trail Immutability

Audit logs MUST be:

- Append-only (no modifications)
- Tamper-evident (hashed, signed)
- Retained per legal requirements

### RULE-070-051: Audit Coverage

Auditable events include:

| Event | Logged Fields |
|-------|---------------|
| Event creation | event_id, timestamp, actor |
| Event processing | event_id, worker_id, result |
| Status changes | event_id, old_status, new_status |
| Deletion/Archive | event_id, reason, operator |
| Access | user_id, resource, timestamp |

### RULE-070-052: Audit Retention

Audit logs MUST be retained:

| Regulation | Minimum |
|------------|---------|
| SOX | 7 years |
| HIPAA | 6 years |
| Default | 3 years |

---

## 7. Encryption

### RULE-070-060: Encryption at Rest

Event data MUST be encrypted at rest:

- Database: Transparent Data Encryption (TDE) or equivalent
- Archives: AES-256
- Backups: Same as source

### RULE-070-061: Encryption in Transit

Event data MUST be encrypted in transit:

- TLS 1.2+ for all connections
- Certificate validation enforced
- mTLS for internal services (RECOMMENDED)

### RULE-070-062: Key Management

Encryption keys MUST:

- Be rotated annually (minimum)
- Be stored in HSM or KMS
- Have access logging
- Support emergency recovery

---

## 8. Prohibitions

### RULE-070-070: No Unencrypted PII

Storing unencrypted PII in event payloads is **PROHIBITED**.

### RULE-070-071: No Retention Without Justification

Retaining data beyond business need is **PROHIBITED**.

### RULE-070-072: No Unapproved Cross-Border Transfer

Transferring data across jurisdictions without:
- Legal basis
- Appropriate safeguards (SCCs, adequacy decision)

is **PROHIBITED**.

---

## References

- [GDPR](https://gdpr.eu/)
- [LGPD](https://www.gov.br/cidadania/pt-br/acesso-a-informacao/lgpd)
- [SOX Compliance](https://www.sec.gov/spotlight/sarbanes-oxley.htm)
- [HIPAA](https://www.hhs.gov/hipaa/index.html)
