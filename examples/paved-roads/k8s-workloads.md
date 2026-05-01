# Paved Road: Kubernetes Workloads

For services running on Acme's shared EKS clusters, use the `acme-workload`
Helm chart:

```yaml
# values.yaml
image:
  repo: ghcr.io/acme/your-service
  tag: v1.2.3
data_class: confidential   # drives network policies and audit logging
runtime:
  cpu: "500m"
  memory: "512Mi"
ingress:
  type: internal           # internal | vpn | public — public requires exception
```

The chart provisions: NetworkPolicy, PodSecurity restrictions, log shipping,
mTLS via the mesh, and HorizontalPodAutoscaler with sane defaults.
