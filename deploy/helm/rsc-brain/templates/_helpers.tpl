{{/* Common naming + labels. */}}
{{- define "rsc-brain.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rsc-brain.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "rsc-brain.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "rsc-brain.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "rsc-brain.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rsc-brain.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Component-scoped names. */}}
{{- define "rsc-brain.db.fullname" -}}{{ printf "%s-db" (include "rsc-brain.fullname" .) }}{{- end -}}
{{- define "rsc-brain.secretName" -}}{{ printf "%s-secrets" (include "rsc-brain.fullname" .) }}{{- end -}}
{{- define "rsc-brain.configName" -}}{{ printf "%s-config" (include "rsc-brain.fullname" .) }}{{- end -}}

{{/* Fully-qualified image reference: registry-prefixed repository + tag. */}}
{{- define "rsc-brain.image" -}}
{{- $reg := .root.Values.image.registry -}}
{{- $repo := .repository -}}
{{- $tag := default .root.Values.image.tag .tag -}}
{{- if $reg -}}{{ printf "%s/%s:%s" $reg $repo $tag }}{{- else -}}{{ printf "%s:%s" $repo $tag }}{{- end -}}
{{- end -}}

{{/*
Preserve-on-upgrade secret material. Priority: an explicit value → the value already stored in the
Secret (so `helm upgrade` never rotates it, FR-4.7) → a freshly generated random. `lookup` returns
empty on first install and during `helm template`, so the random branch fires there.
*/}}
{{- define "rsc-brain.preservedSecret" -}}
{{- $explicit := .explicit -}}
{{- if $explicit -}}{{ $explicit }}{{- else -}}
{{- $existing := (lookup "v1" "Secret" .root.Release.Namespace (include "rsc-brain.secretName" .root)) -}}
{{- if and $existing (index $existing.data .key) -}}
{{- index $existing.data .key | b64dec -}}
{{- else -}}{{ randAlphaNum 32 }}{{- end -}}
{{- end -}}
{{- end -}}

