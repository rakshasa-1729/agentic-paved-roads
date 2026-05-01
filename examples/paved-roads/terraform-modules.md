# Paved Road: Terraform Modules

Use these modules instead of authoring resources directly. They bake in tagging,
encryption, logging, and IAM defaults that satisfy `policy_tool` policies.

| Need                       | Module                                                                 | Notes |
|----------------------------|------------------------------------------------------------------------|-------|
| AWS Elasticache Redis      | `git::ssh://git@github.com/acme/terraform-modules.git//modules/redis` | TLS on by default; auto-rotates auth token. |
| AWS S3 bucket              | `…//modules/s3-bucket`                                                | Block public access enforced; SSE-KMS. |
| Cross-account IAM role     | `…//modules/iam-role-crossaccount`                                    | Requires `external_id`. |
| Ephemeral sandbox resource | `…//modules/ephemeral-resource`                                       | Wraps any resource with `expires_at` enforcement. |

If your need does not fit a paved road, file a paved-road request rather than
forking — duplicated paved roads is how drift starts.
