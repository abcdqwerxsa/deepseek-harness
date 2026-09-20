import { useMemo, useState } from 'react'
import { apiClient, type ConfigOption, type ConfigOptionEntry } from './api'

interface FlatModel {
  readonly value: string
  readonly label: string
}

/** Flatten the ACP model option's grouped catalog into picker entries. */
function flatModels(option: ConfigOption): readonly FlatModel[] {
  const entries: FlatModel[] = []
  for (const group of option.options ?? []) {
    if ('options' in group) {
      const prefix = group.name ?? group.group ?? ''
      for (const entry of group.options) {
        entries.push({ value: entry.value, label: prefix === '' ? entry.name : `${prefix} · ${entry.name}` })
      }
    } else {
      entries.push({ value: group.value, label: group.name })
    }
  }
  return entries
}

/**
 * Model switcher over the session's ACP `model` config option. The choice is
 * pinned at prompt admission and applies from the next turn (decision 5);
 * the catalog refreshes from setConfigOption responses and
 * config_option_update notifications.
 */
export function ModelPicker({ sessionId, configOptions, onApplied }: {
  sessionId: string | null
  configOptions: readonly ConfigOption[] | null
  onApplied: (options: readonly ConfigOption[]) => void
}) {
  const models = useMemo(() => {
    const option = configOptions?.find(option => option.id === 'model')
    return option === undefined ? [] : flatModels(option)
  }, [configOptions])
  const current = configOptions?.find(option => option.id === 'model')?.currentValue
  const [busy, setBusy] = useState(false)

  if (sessionId === null || models.length === 0) return null

  const apply = async (value: string) => {
    if (busy || value === current) return
    setBusy(true)
    try {
      const res = await apiClient.sessionConfig(sessionId, 'model', value)
      onApplied(res.configOptions ?? [])
    } catch {
      /* a failed switch keeps the current selection; the next catalog
         refresh (config_option_update) re-syncs the picker */
    } finally {
      setBusy(false)
    }
  }

  return (
    <select
      className="model-picker"
      value={current ?? ''}
      disabled={busy}
      title="切换模型（下一轮对话生效）"
      onChange={e => { void apply(e.target.value) }}
    >
      {models.map(model => (
        <option key={model.value} value={model.value}>{model.label}</option>
      ))}
    </select>
  )
}
