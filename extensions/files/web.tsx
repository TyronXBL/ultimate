import { FolderOpenIcon } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { defineWebExtension, provide } from '@/sdk'
import { FilesLink } from './link.tsx'
import { FilePathLink, InlineFilePath, OpenFile, provideOpenFile } from './paths.tsx'

// The viewer and its highlighter load with the surface, not with the app.
const Viewer = lazy(() => import('./surface.tsx'))

function FilesSurface() {
  return (
    <Suspense fallback={null}>
      <Viewer />
    </Suspense>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'files',
      title: 'Files',
      icon: FolderOpenIcon,
      description: 'Read project files: on main or in a branch’s worktree',
      order: 65,
      component: FilesSurface,
    },
  ],
  commands: [
    { id: 'files.open', title: 'Open Files', run: (context) => context.showSurface('files') },
  ],
  slots: { overlay: [FilesLink] },
  link: FilePathLink,
  inlineCode: InlineFilePath,
  provides: [provide(OpenFile, provideOpenFile)],
})
