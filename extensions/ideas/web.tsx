import { KanbanIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import { Board } from './board.tsx'
import { LaunchCard } from './launch.tsx'

export default defineWebExtension({
  surfaces: [
    {
      id: 'ideas',
      title: 'Board',
      icon: KanbanIcon,
      description: 'Ideas from collected to landed, with what waits on you',
      order: 1,
      component: Board,
    },
  ],
  entries: { 'ideas.launch': LaunchCard },
})
