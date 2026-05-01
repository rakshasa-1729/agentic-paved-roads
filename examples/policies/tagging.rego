package main

required_tags := {"owner", "cost_center", "env", "data_class"}

deny[msg] {
  resource := input.resource_changes[_]
  startswith(resource.type, "aws_")
  tags := object.get(resource.change.after, "tags", {})
  missing := required_tags - {t | tags[t]}
  count(missing) > 0
  msg := sprintf("%s is missing required tags: %v", [resource.address, missing])
}

deny[msg] {
  resource := input.resource_changes[_]
  tags := object.get(resource.change.after, "tags", {})
  tags.env == "sandbox"
  not tags.expires_at
  msg := sprintf("%s in env=sandbox must set expires_at", [resource.address])
}
