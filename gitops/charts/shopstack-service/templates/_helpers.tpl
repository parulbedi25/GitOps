{{/*
Common name helpers.

Label conventions follow the Kubernetes recommended labels
(https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/)
plus three ShopStack-specific labels used by NetworkPolicies, Kyverno policies and
Argo Rollouts analysis:
  shopstack.io/environment : dev|qa|prod
  shopstack.io/tier        : edge|core|data
  shopstack.io/managed-by  : gitops   (never edited by humans)
*/}}

{{/*
This chart is a *generic* service template: the Release name IS the service name
(`helm install storefront ./shopstack-service` renders `storefront`), which keeps
object names identical to the service names used in DNS, NetworkPolicies and
Prometheus queries.
*/}}
{{- define "shopstack.name" -}}
{{- default .Release.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "shopstack.fullname" -}}
{{- default (include "shopstack.name" .) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "shopstack.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "shopstack.selectorLabels" -}}
app.kubernetes.io/name: {{ include "shopstack.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "shopstack.labels" -}}
helm.sh/chart: {{ include "shopstack.chart" . }}
{{ include "shopstack.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: {{ .Release.Name }}
app.kubernetes.io/part-of: shopstack
shopstack.io/environment: {{ .Values.global.environment }}
shopstack.io/tier: {{ .Values.tier | default "core" }}
shopstack.io/managed-by: gitops
{{- end -}}

{{- define "shopstack.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "shopstack.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Resolves registry/repository and prefers a digest over a tag when given. */}}
{{- define "shopstack.image" -}}
{{- $registry := .Values.image.registry | default .Values.global.imageRegistry -}}
{{- $repo := .Values.image.repository -}}
{{- if $registry -}}
{{- $repo = printf "%s/%s" $registry $repo -}}
{{- end -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $repo .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}
{{- end -}}

{{- define "shopstack.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end -}}
{{- end -}}

{{- define "shopstack.configMapName" -}}
{{- printf "%s-config" (include "shopstack.fullname" .) -}}
{{- end -}}

{{- define "shopstack.secretName" -}}
{{- default (include "shopstack.fullname" .) .Values.secrets.name -}}
{{- end -}}

{{- define "shopstack.canaryServiceName" -}}
{{- printf "%s-canary" (include "shopstack.fullname" .) -}}
{{- end -}}

{{/*
Pod-level annotations. The config checksum forces a rollout when only config
changed — otherwise Kubernetes considers the pod template unchanged and keeps
serving stale environment variables. 
*/}}
{{- define "shopstack.podAnnotations" -}}
checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- with .Values.podAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Renders a probe block. Kept in one helper so liveness, readiness and startup can
never drift apart between the Deployment and Rollout templates.
*/}}
{{- define "shopstack.probe" -}}
{{- $p := .probe -}}
httpGet:
  path: {{ $p.path }}
  port: http
{{- if hasKey $p "initialDelaySeconds" }}
initialDelaySeconds: {{ $p.initialDelaySeconds }}
{{- end }}
periodSeconds: {{ $p.periodSeconds }}
timeoutSeconds: {{ $p.timeoutSeconds }}
failureThreshold: {{ $p.failureThreshold }}
{{- if hasKey $p "successThreshold" }}
successThreshold: {{ $p.successThreshold }}
{{- end }}
{{- end -}}

{{/* Container definition shared by Deployment and Rollout. */}}
{{- define "shopstack.container" -}}
- name: {{ include "shopstack.name" . }}
  image: {{ include "shopstack.image" . | quote }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  {{- with .Values.command }}
  command: {{ toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.args }}
  args: {{ toYaml . | nindent 4 }}
  {{- end }}
  ports:
    - name: http
      containerPort: {{ .Values.containerPort }}
      protocol: TCP
  envFrom:
    {{- if .Values.config }}
    - configMapRef:
        name: {{ include "shopstack.configMapName" . }}
    {{- end }}
    {{- if and .Values.secrets.enabled .Values.secrets.data }}
    - secretRef:
        name: {{ include "shopstack.secretName" . }}
        optional: {{ .Values.secrets.optional }}
    {{- end }}
    {{- with .Values.extraEnvFrom }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  env:
    - name: POD_NAME
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    - name: POD_NAMESPACE
      valueFrom:
        fieldRef:
          fieldPath: metadata.namespace
    - name: NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    {{- with .Values.extraEnv }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- if .Values.probes.startup.enabled }}
  startupProbe:
    {{- include "shopstack.probe" (dict "probe" .Values.probes.startup) | nindent 4 }}
  {{- end }}
  {{- if .Values.probes.liveness.enabled }}
  livenessProbe:
    {{- include "shopstack.probe" (dict "probe" .Values.probes.liveness) | nindent 4 }}
  {{- end }}
  {{- if .Values.probes.readiness.enabled }}
  readinessProbe:
    {{- include "shopstack.probe" (dict "probe" .Values.probes.readiness) | nindent 4 }}
  {{- end }}
  resources:
    {{- toYaml .Values.resources | nindent 4 }}
  securityContext:
    {{- toYaml .Values.securityContext | nindent 4 }}
  volumeMounts:
    # readOnlyRootFilesystem is on, so /tmp must be writable.
    - name: tmp
      mountPath: /tmp
    {{- with .Values.extraVolumeMounts }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- if gt (int .Values.lifecycle.preStopSleepSeconds) 0 }}
  lifecycle:
    preStop:
      exec:
        # Give kube-proxy/Envoy time to stop routing to this pod before Node
        # closes the listener. Without it, canary analysis sees 502s that are
        # not the release's fault.
        command: ["/bin/sh", "-c", "sleep {{ .Values.lifecycle.preStopSleepSeconds }}"]
  {{- end }}
{{- end -}}

{{/* Pod spec shared by Deployment and Rollout. */}}
{{- define "shopstack.podSpec" -}}
serviceAccountName: {{ include "shopstack.serviceAccountName" . }}
automountServiceAccountToken: {{ .Values.serviceAccount.automountServiceAccountToken }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
{{- include "shopstack.imagePullSecrets" . | nindent 0 }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.topologySpreadConstraints }}
topologySpreadConstraints:
{{- range . }}
  - maxSkew: {{ .maxSkew }}
    topologyKey: {{ .topologyKey }}
    whenUnsatisfiable: {{ .whenUnsatisfiable }}
    labelSelector:
      {{- if .labelSelector.matchLabels }}
      matchLabels:
        {{- toYaml .labelSelector.matchLabels | nindent 8 }}
      {{- else }}
      matchLabels:
        {{- include "shopstack.selectorLabels" $ | nindent 8 }}
      {{- end }}
{{- end }}
{{- end }}
containers:
  {{- include "shopstack.container" . | nindent 2 }}
volumes:
  - name: tmp
    emptyDir: {}
  {{- with .Values.extraVolumes }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
{{- end -}}
