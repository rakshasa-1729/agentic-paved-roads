# Risk Context: Data Classification

| Class        | Examples                                  | Rules of thumb |
|--------------|-------------------------------------------|----------------|
| public       | Marketing site, OSS docs.                 | Anything goes. |
| internal     | Engineering wiki, internal dashboards.    | Auth required; no public ingress. |
| confidential | Customer metadata, support tickets.       | Encryption at rest + in transit; private subnet; auditable access. |
| restricted   | Payment data, raw user content, secrets.  | Dedicated account, KMS CMK, no cross-account egress without exception. |

If you do not know the class of the data a workload handles, **stop and ask**.
Misclassification is the single biggest source of incidents.
