import { CpuIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  provide,
  useAction,
  useDialog,
  useUiState,
  useUltimate,
} from '@/sdk'
import { SYSTEM_TAB_KEY, SystemTab } from '../system/ui.tsx'
import { HOUR_MS } from './charts.tsx'
import { Dashboard, describePressure } from './dashboard.tsx'
import { StateAction, SummaryAction } from './refs.ts'
import type { MachineState, Sample } from './refs.ts'

const TAB = 'machine'

/** Selects System's Machine tab, then shows System. */
function useOpenMachine() {
  const [, setTab] = useUiState<string>(SYSTEM_TAB_KEY, 'agents')
  const { showSurface } = useUltimate()
  return () => {
    setTab(TAB)
    showSurface('system')
  }
}

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
/** Whether the System surface is on screen in a visible tab: the tab polls only then. */
function useLive() {
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState === 'visible')
  return useUltimate().surface === 'system' && visible
}

/**
 * The machine every 3 s while `live`. The first ask returns the last hour of samples, each later one only the samples
 * after the newest kept here; they are appended and the hour is kept in the browser.
 */
function useMachine(live: boolean) {
  const [state, setState] = useState<{ data?: MachineState; error?: unknown }>({})
  const samples = useRef<Sample[]>([])
  useEffect(() => {
    if (!live) return undefined
    const controller = new AbortController()
    const load = () =>
      api
        .action(StateAction, { since: samples.current.at(-1)?.at }, { signal: controller.signal })
        .then((data) => {
          samples.current = [...samples.current, ...data.samples].filter(
            (sample) => sample.at >= data.now - HOUR_MS,
          )
          setState({ data: { ...data, samples: samples.current } })
        })
        .catch((error: unknown) => {
          // Aborted when the tab hides; the next fetch owns the state.
          if (!controller.signal.aborted) setState((previous) => ({ ...previous, error }))
        })
    // oxlint-disable-next-line typescript/no-floating-promises -- load catches failures and stores them in the displayed error state.
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [live])
  return state
}

function Machine() {
  const { data, error } = useMachine(useLive())
  return (
    <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      {data ? (
        <Dashboard samples={data.samples} state={data} />
      ) : (
        <p className="py-6 text-center font-mono text-[11px] text-muted-foreground/70">
          {error ? `machine failed: ${errorMessage(error)}` : 'loading…'}
        </p>
      )}
    </main>
  )
}

/**
 * The status-line chip: the queue's length, amber while something needs attention, hidden while nothing runs and
 * nothing is wrong. A click opens the Machine tab.
 */
function Chip() {
  const { data } = useAction(SummaryAction, null, {
    every: 15_000,
    // A failed poll keeps the last summary; the next one asks again.
    onError: () => {},
  })
  const open = useOpenMachine()
  if (!data) return null
  const queued = data.running + data.waiting
  const attention = data.pressure.length > 0
  if (queued === 0 && !attention) return null
  const title = [
    `${data.running} running · ${data.waiting} waiting`,
    ...data.pressure.map((pressure) => describePressure(pressure).text),
  ].join('\n')
  return (
    <button
      aria-label="Machine"
      className={cn(
        '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground',
        attention && 'text-warning hover:text-warning',
      )}
      data-machine={attention ? 'attention' : 'queue'}
      onClick={open}
      title={title}
      type="button"
    >
      <CpuIcon className="size-3" />
      {queued > 0 ? (
        <span className="tabular-nums">
          <span className="md:hidden">{queued}</span>
          <span className="max-md:hidden">
            {data.running} running{data.waiting > 0 && ` · ${data.waiting} waiting`}
          </span>
        </span>
      ) : (
        <span>machine</span>
      )}
    </button>
  )
}

const openDialog = 'machine.open'

/** The ⌘K command opens this pseudo-dialog; selecting System's Machine tab needs a hook, so a component does it. */
function OpenOnCommand() {
  const [open, setOpen] = useDialog(openDialog)
  const openMachine = useOpenMachine()
  useEffect(() => {
    if (!open) return
    setOpen(false)
    openMachine()
  }, [open, setOpen, openMachine])
  return null
}

const tab = { id: TAB, title: 'Machine', component: Machine }

export default defineWebExtension({
  provides: [provide(SystemTab, () => tab)],
  commands: [
    { id: 'machine.open', title: 'Open Machine', run: (context) => context.open(openDialog) },
  ],
  slots: {
    'statusline.right': [{ component: Chip, order: -2, phone: true }],
    overlay: [OpenOnCommand],
  },
})
