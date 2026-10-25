// Profiles: adding one, renaming and recoloring, the default profile, and what can't be deleted.
// Deleting a profile asks in a native dialog first, which a test can't answer, so only the cases
// that never get that far are covered. Tabs in profiles are in tab-profiles.test.ts.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { html, launch, removeDir, serve, tempDir, waitFor, type Jbrow, type TestServer } from './harness'
import { activeTab, offline, record } from './ui-helpers'

let jb: Jbrow
let web: TestServer
let userData: string

before(async () => {
  web = await serve({ '/': html('Home') })
  userData = tempDir()
  jb = await launch({
    userData,
    settings: {
      ...offline(web),
      profiles: [
        { id: 'work', name: 'Work', color: '#2f9aab' },
        { id: 'personal', name: 'Personal', color: '#d0679a' },
      ],
      defaultProfile: 'personal',
    },
  })
})
after(async () => {
  await jb?.close()
  await web?.close()
  await removeDir(userData)
})

const saved = () => jb.readJson('settings.json')

test("'add-profile' adds a profile with the next free number and color", async () => {
  await jb.send('add-profile', { rename: false })
  const s = await jb.waitForState((s) => s.profiles.length === 3, 'a third profile')
  const p = s.profiles[2]
  assert.equal(p.id, 'profile-3')
  assert.equal(p.name, 'Profile 3')
  assert.match(p.color, /^#[0-9a-f]{6}$/i)
  assert.ok(!['#2f9aab', '#d0679a'].includes(p.color), 'a color no other profile has')
  await waitFor(() => saved().profiles.some((x: { id: string }) => x.id === 'profile-3'), 'settings.json to have it')
  // Its tabs work: a page opens in it.
  await jb.send('new')
  await jb.waitForState((s) => !!activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('set-profile', { profile: 'profile-3' })
  await jb.waitForState((s) => activeTab(s)?.profile === 'profile-3', 'the tab in the new profile')
  await jb.send('navigate', { input: `${web.url}/` })
  const t = await jb.waitForState((s) => activeTab(s)?.title === 'Home', 'the page in the new profile')
  assert.equal(activeTab(t)!.profile, 'profile-3')
})

test("'add-profile' with renaming asks the UI to rename it", async () => {
  const renames = await record<string>(jb, 'rename-profile')
  await jb.send('add-profile')
  const s = await jb.waitForState((s) => s.profiles.length === 4, 'a fourth profile')
  const id = s.profiles[3].id
  assert.equal(id, 'profile-4')
  await renames.waitFor((r) => r === id, 'the rename request')
})

test("'profile' renames and recolors; nonsense is ignored", async () => {
  await jb.send('profile', { id: 'profile-3', name: '  Side project  ', color: '#123abc' })
  let s = await jb.waitForState((s) => s.profiles.some((p) => p.name === 'Side project'), 'the new name')
  assert.deepEqual(s.profiles.find((p) => p.id === 'profile-3'), { id: 'profile-3', name: 'Side project', color: '#123abc' })
  await jb.send('profile', { id: 'profile-3', name: '   ', color: 'red' })
  await jb.send('profile', { id: 'nobody', name: 'Ghost' })
  // A change that does apply, to know the ones before it were handled.
  await jb.send('profile', { id: 'work', color: '#000000' })
  s = await jb.waitForState((s) => s.profiles.find((p) => p.id === 'work')?.color === '#000000', 'the work color')
  assert.deepEqual(s.profiles.find((p) => p.id === 'profile-3'), { id: 'profile-3', name: 'Side project', color: '#123abc' })
  assert.ok(!s.profiles.some((p) => p.name === 'Ghost'))
  const file = saved().profiles.find((p: { id: string }) => p.id === 'profile-3')
  assert.deepEqual(file, { id: 'profile-3', name: 'Side project', color: '#123abc' })
})

test("'default-profile' picks the profile new tabs and links use", async () => {
  await jb.send('default-profile', { id: 'work' })
  await jb.waitForState((s) => s.prefs.defaultProfile === 'work', 'work as the default')
  await waitFor(() => saved().defaultProfile === 'work', 'settings.json to have it')
  // A profile that doesn't exist can't be the default.
  await jb.send('default-profile', { id: 'nobody' })
  await jb.send('profile', { id: 'work', name: 'Work' })
  await jb.send('add-profile', { rename: false })
  await jb.waitForState((s) => s.profiles.length === 5, 'a later change')
  assert.equal((await jb.state()).prefs.defaultProfile, 'work')
  await jb.send('default-profile', { id: 'profile-3' })
  await jb.waitForState((s) => s.prefs.defaultProfile === 'profile-3', 'profile-3 as the default')
})

test('profiles and the default survive a relaunch', async () => {
  const before = await jb.state()
  await jb.quit()
  jb = await launch({ userData })
  const s = await jb.state()
  assert.deepEqual(s.profiles, before.profiles)
  assert.equal(s.prefs.defaultProfile, 'profile-3')
  // The next new profile doesn't take a number in use.
  await jb.send('add-profile', { rename: false })
  const more = await jb.waitForState((s) => s.profiles.length === 6, 'a sixth profile')
  assert.equal(more.profiles[5].id, 'profile-6')
})

test("'delete-profile' of a profile that doesn't exist does nothing", async () => {
  await jb.send('delete-profile', { id: 'nobody' })
  await jb.send('profile', { id: 'work', name: 'Work!' })
  const s = await jb.waitForState((s) => s.profiles.some((p) => p.name === 'Work!'), 'a later change')
  assert.equal(s.profiles.length, 6)
})

test('the last profile cannot be deleted', async () => {
  const solo = await launch({ settings: { ...offline(web), profiles: [{ id: 'only', name: 'Only', color: '#2f9aab' }], defaultProfile: 'only' } })
  try {
    await solo.send('delete-profile', { id: 'only' })
    await solo.send('profile', { id: 'only', name: 'Still here' })
    const s = await solo.waitForState((s) => s.profiles[0]?.name === 'Still here', 'a later change')
    assert.deepEqual(s.profiles.map((p) => p.id), ['only'])
    assert.equal(solo.readJson('settings.json').profiles.length, 1)
  } finally {
    await solo.close()
  }
})
