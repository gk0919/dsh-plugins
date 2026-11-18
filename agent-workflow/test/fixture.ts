import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface Fixture {
  root: string
  cleanup(): void
}

export function workspace(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-workflow-'))
  mkdirSync(path.join(root, '.agent-workflow', 'tasks'), { recursive: true })
  writeFileSync(path.join(root, '.agent-workflow', 'config.json'), JSON.stringify({
    schemaVersion: 1, activeProfile: 'workflow:resources/profiles/default/profile.json', plugins: [],
    paths: { tasksRoot: '.agent-workflow/tasks', runtimeRoot: '.agent-workflow/runtime', skillsRoot: '.agents/skills', knowledgeRoot: '.agent-workflow/knowledge' },
  }))
  writeFileSync(path.join(root, '.gitignore'), '.agent-workflow/\n')
  writeFileSync(path.join(root, 'AGENTS.md'), '# Host constraints\n')
  writeFileSync(path.join(root, 'code.txt'), 'user content\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' })
  git('init', '--quiet'); git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export const start = 'start ' + JSON.stringify({ taskId: 'plugin-test', route: 'task-workflow-maintenance', entry: 'not-applicable', goal: 'Controlled plugin integration' })
export const plan = '---\nplan_version: 1\ntask_id: plugin-test\n---\n\n## Work Items\n- [ ] T1: Controlled edits\n  - Stage: Implement\n  - Artifact: changes.md#Implementation\n  - Done When: Content is updated\n'
