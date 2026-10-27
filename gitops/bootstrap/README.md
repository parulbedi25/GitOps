# Bootstrap layer

The one place in this repository where something is installed by hand. It exists
because Argo CD cannot deploy itself: something has to create the first
`Application`.

```
gitops/bootstrap/
├── bootstrap.sh            # install Argo CD (pinned chart), then apply the root app
├── values/argo-cd.yaml     # Argo CD's own values: HA server, ingress, RBAC, metrics
├── root-app-dev.yaml       # app-of-apps entry point for the dev cluster
├── root-app-qa.yaml
└── root-app-prod.yaml
```

## What happens when you run it

```bash
gitops/bootstrap/bootstrap.sh dev
```

1. **Preflight** — `kubectl` and `helm` exist, and the cluster answers on the
   current context (or the one you pass with `--context`).
2. **Install** — `helm upgrade --install argo-cd argo/argo-cd --version 10.11.6`
   with `values/argo-cd.yaml`. The chart version is a variable at the top of the
   script; it is the only Argo CD pin in the repository.
3. **Wait** — server, repo server, ApplicationSet controller, redis and the
   controller StatefulSet all roll out.
4. **Hand over** — `kubectl apply -f root-app-<env>.yaml`. That single
   `Application` syncs `gitops/clusters/<env>`, which declares every other
   `Application` in dependency order (AppProjects at wave `-20`, namespaces at
   `-10`, controllers at `0`, policies at `5`, observability at `10`, services at
   `20`, storefront at `30`).
5. **Print** — the admin password command, the port-forward and the watch
   command.

`--dry-run` prints the exact commands without touching the cluster; `--help`
lists the flags.

## Why Argo CD is not managed by Argo CD here

Self-managing Argo CD is the correct end state and a common next step: add
`platform/argo-cd` to `gitops/platform/controllers`, adopt the release with
`argocd app adopt`-style annotations, and drop the `helm upgrade` from this
script. It is deliberately **not** the first step — a broken self-managed Argo CD
cannot roll itself back. Bootstrap is allowed to be boring.

## After bootstrap

```bash
kubectl -n argocd get applications -w          # watch the tree converge
kubectl -n argocd get app shopstack-root -o jsonpath='{.status.health.status}'
```

Once `shopstack-root` is `Synced`/`Healthy`, the cluster stops being something
you configure and becomes something you describe in Git.
