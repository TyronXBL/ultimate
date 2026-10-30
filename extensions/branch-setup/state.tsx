/**
 * The next branch's setup in this tab, the agents it can name with what each runs on today, and the setups to start from
 * (defaults, a family for all, the saved presets).
 */
import { useSyncExternalStore } from 'react'
import { useAction, useModels } from '@/sdk'
import { familyTitle } from '../../lib/families.ts'
import { DefinitionsAction } from '../subagents/ui.tsx'
import type { Discovery } from '../subagents/refs.ts'
import { runsOn, useFamilies } from '../models/ui.tsx'
import type { FamilyView } from '../models/ui.tsx'
import { PresetsAction } from './refs.ts'
import type { Agents } from './refs.ts'

/** A model as `provider/id`, with the thinking level it runs at; none is the model's own default. */
export type Pick = { model: string; thinking?: string }
/** One agent of the sheet: what it runs on without a setup, and where it sits in the list. */
export type AgentRow = { name: string; base: Pick; under?: string; more?: boolean }

const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export const encode = (pick: Pick) =>
  pick.thinking ? `${pick.model}:${pick.thinking}` : pick.model

/** `provider/id[:thinking]` as a pick; a colon that is not a thinking level belongs to the model id. */
export function decode(value: string): Pick {
  const at = value.lastIndexOf(':')
  const level = at > 0 ? value.slice(at + 1) : ''
  return levels.has(level) ? { model: value.slice(0, at), thinking: level } : { model: value }
}

export const modelId = (model: string) => model.slice(model.indexOf('/') + 1)

/** "gpt-6-luna · medium". */
export const pickLabel = (pick: Pick) =>
  pick.thinking ? `${modelId(pick.model)} · ${pick.thinking}` : modelId(pick.model)

/** The agents a branch runs, in the order the sheet lists them; the review team under the reviewer. */
const order = ['coordinator', 'worker', 'designer', 'scout', 'reviewer']

function rowsOf(discovery: Discovery): AgentRow[] {
  const main = discovery.main.model
  const rows = discovery.definitions
    .filter((definition) => !definition.resident)
    .flatMap((definition): AgentRow[] => {
      const runs = definition.runs
      // A definition on the default family runs the main model.
      const model = runs?.model ?? main
      if (!model) return []
      const thinking = runs?.model ? runs.thinking : (runs?.thinking ?? discovery.main.thinking)
      const base = {
        model: `${model.provider}/${model.modelId}`,
        ...(thinking ? { thinking } : {}),
      }
      const team = definition.name.startsWith('reviewer-')
      return [
        {
          name: definition.name,
          base,
          ...(team ? { under: 'reviewer' } : {}),
          ...(!team && !order.includes(definition.name) ? { more: true } : {}),
        },
      ]
    })
  const rank = (row: AgentRow) => {
    const at = order.indexOf(row.under ?? row.name)
    return at === -1 ? order.length : at
  }
  return rows.toSorted(
    (a, b) =>
      rank(a) - rank(b) || Number(!!a.under) - Number(!!b.under) || a.name.localeCompare(b.name),
  )
}

/** The agents a setup can name, each with what it runs on today; undefined while loading. */
export function useAgentRows(enabled = true) {
  const { data, refetch } = useAction(DefinitionsAction, null, { enabled })
  return { rows: data ? rowsOf(data) : undefined, refetch }
}

/** Only the agents `agents` sets to something other than what they run on today, and only agents the sheet lists. */
function changedOnly(agents: Agents, rows: readonly AgentRow[]): Agents {
  return Object.fromEntries(
    rows.flatMap((row) => {
      const value = agents[row.name]
      return value && value !== encode(row.base) ? [[row.name, value]] : []
    }),
  )
}

const sameAgents = (a: Agents, b: Agents) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([name, value]) => b[name] === value)

// ---- this tab's setup for the next branch --------------------------------------------------------------------------

let next: Agents = {}
const listeners = new Set<() => void>()

/** The agents the user changed for the next branch, as `provider/id[:thinking]`. */
export const useSetup = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => next,
  )

export function setSetup(agents: Agents) {
  next = agents
  for (const listener of listeners) listener()
}

// ---- setups to start from ------------------------------------------------------------------------------------------

/** A whole setup to apply: the defaults, every agent on one family, or a saved preset. */
export type Choice = {
  key: string
  label: string
  /** The family or preset alone, where "All on" goes without saying. */
  short: string
  detail?: string
  agents: Agents
  family?: FamilyView
  saved?: boolean
}

/**
 * The setups to start from for `rows`, each holding only what differs from today's: Defaults, "All on <family>" for
 * every family whose model has a login here, then the saved presets. `current` is the one `setup` matches.
 */
export function useChoices(rows: readonly AgentRow[] | undefined, setup: Agents) {
  const families = useFamilies()
  const models = useModels()
  const presets = useAction(PresetsAction, null, { enabled: rows !== undefined })
  const available = new Set(
    (models?.models ?? [])
      .filter((model) => model.available)
      .map((model) => `${model.provider}/${model.id}`),
  )
  const list: Choice[] = []
  if (rows) {
    list.push({
      key: 'defaults',
      label: 'Defaults',
      short: 'Defaults',
      detail: 'as defined',
      agents: {},
    })
    for (const family of families?.families ?? []) {
      const model = runsOn(family)
      if (!model || !available.has(model)) continue
      const thinking = family.thinking ?? (family.model ? undefined : family.followsThinking)
      const value = encode({ model, ...(thinking ? { thinking } : {}) })
      list.push({
        key: `family:${family.name}`,
        label: `All on ${familyTitle(family.name)}`,
        short: familyTitle(family.name),
        detail: pickLabel(decode(value)),
        agents: changedOnly(Object.fromEntries(rows.map((row) => [row.name, value])), rows),
        family,
      })
    }
    for (const [name, saved] of Object.entries(presets.data?.presets ?? {})) {
      const agents = changedOnly(saved, rows)
      const count = Object.keys(agents).length
      list.push({
        key: `preset:${name}`,
        label: name,
        short: name,
        detail: `${count} ${count === 1 ? 'change' : 'changes'}`,
        agents,
        saved: true,
      })
    }
  }
  // Saved presets first: a preset that equals a family's setup is still the one the user named.
  const current = [...list.filter((choice) => choice.saved), ...list].find((choice) =>
    sameAgents(choice.agents, setup),
  )
  return { choices: list, current, presets: presets.data?.presets, refetch: presets.refetch }
}
