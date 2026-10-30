import type { ReactNode } from 'react'
import { api, useConversation } from '@/sdk'
import type { FileTarget } from './link.tsx'
import { openFile } from './link.tsx'
import { OpenFile } from '../coding-tools/ui.tsx'
import { isFilePathCode, splitLine } from './path-detection.tsx'
import { LocateAction } from './refs.ts'
export { OpenFile }

function FileButton({ path, line, conversation, children }: FileTarget & { children: ReactNode }) {
  const activate = () => {
    void api
      .action(LocateAction, { path, conversation })
      .then((hit) =>
        openFile({ ...(hit ?? { path, conversation }), ...(line !== undefined && { line }) }),
      )
      .catch(() => openFile({ path, conversation, line }))
  }
  return (
    <button
      className="cursor-pointer rounded-sm text-inherit hover:text-brand hover:underline pointer-coarse:py-1.5"
      onClick={activate}
      type="button"
    >
      {children}
    </button>
  )
}

export function InlineFilePath({ code, core }: { code: string; core: ReactNode }) {
  const conversation = useConversation((current) => current.id)
  if (!isFilePathCode(code)) return core
  const { path, line } = splitLine(code)
  return (
    <FileButton conversation={conversation} line={line} path={path}>
      {core}
    </FileButton>
  )
}

function isFileHref(href: string) {
  if (href.startsWith('//')) return false
  if (href.startsWith('/') && !href.startsWith('/?')) return true
  return !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('/?')
}

export function FilePathLink({
  href,
  children,
  core,
}: {
  href: string
  children: ReactNode
  core: ReactNode
}) {
  const conversation = useConversation((current) => current.id)
  if (!isFileHref(href)) return core
  const { path, line } = splitLine(href)
  return (
    <FileButton conversation={conversation} line={line} path={path}>
      {children}
    </FileButton>
  )
}

/** Provider registered by Files for coding-tools' optional open-file point. */
export function provideOpenFile(target: FileTarget) {
  return () => {
    void api
      .action(LocateAction, { path: target.path, conversation: target.conversation })
      .then((hit) =>
        openFile({ ...(hit ?? target), ...(target.line !== undefined && { line: target.line }) }),
      )
      .catch(() => openFile(target))
  }
}
