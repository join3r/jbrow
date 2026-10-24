// Builds src/main/top-sites.json, the popular sites the address bar completes to when your history
// has nothing for what's typed. Run it now and then to keep the list fresh: npm run top-sites
//
// Which sites: the Chrome UX Report's most visited origins, worldwide and in Slovakia, so only
// pages people open themselves are in (no CDNs or ad servers). Their order: CrUX only says "top
// 1k" or "top 5k", so first a site's best bucket of the two, then its Tranco rank, raised for a
// site visited in Slovakia and more for a .sk one: "pay" is paypal.com, "bazo" bazos.sk over
// bazos.cz. Each site keeps its bucket, as the address bar only completes a few letters to a top
// 1k site. Adult sites are left out, since a completion shows on screen.
import { writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const CRUX = 'https://raw.githubusercontent.com/zakird/crux-top-lists/main/data'
const COUNTRY = 'sk'
/** CrUX ranks to take, worldwide and in the country. */
const GLOBAL_TOP = 5000
const COUNTRY_TOP = 5000
/** A subdomain (mail.google.com) only when it's this popular: most below are logins and shards. */
const SUBDOMAIN_TOP = 1000
const SUBDOMAIN_PENALTY = 10
const OUT = 'src/main/top-sites.json'

async function get(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res
}

/** The newest monthly CrUX list for a place, as [origin, rank] rows. */
async function crux(place) {
  const listing = await (await get(`https://api.github.com/repos/zakird/crux-top-lists/contents/data/${place}`)).json()
  const newest = listing
    .map((f) => f.name)
    .filter((n) => /^\d{6}\.csv\.gz$/.test(n))
    .sort()
    .at(-1)
  const csv = gunzipSync(Buffer.from(await (await get(`${CRUX}/${place}/${newest}`)).arrayBuffer())).toString()
  console.log(`top-sites: CrUX ${place} ${newest}`)
  return csv
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .filter(([origin, rank]) => origin && rank)
    .map(([origin, rank]) => [origin, Number(rank)])
}

async function tranco() {
  const latest = await (await get('https://tranco-list.eu/api/lists/date/latest')).json()
  const csv = await (await get(`https://tranco-list.eu/download/${latest.list_id}/1000000`)).text()
  console.log(`top-sites: Tranco ${latest.list_id}`)
  const ranks = new Map()
  for (const line of csv.split('\n')) {
    const [rank, domain] = line.trim().split(',')
    if (domain) ranks.set(domain, Number(rank))
  }
  return ranks
}

async function adult() {
  const text = await (await get('https://blocklistproject.github.io/Lists/alt-version/porn-nl.txt')).text()
  return new Set(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.trim()))
}

/** The host and every parent domain of it, longest first: a.b.example.com, b.example.com, example.com. */
const parents = (host) => host.split('.').map((_, i, parts) => parts.slice(i).join('.')).slice(0, -1)

const ADULT_WORDS = /porn|xxx|sex|xvideo|xnxx|hentai|nsfw|onlyfans|fansly|chaturbate|stripchat|camsoda|bongacams|livejasmin|erotic|nude|escort|milf|fetish/i

const [global, country, ranks, blocked] = await Promise.all([crux('global'), crux(`country/${COUNTRY}`), tranco(), adult()])

const sites = new Map()
function put(bare, host, rank, key) {
  const site = sites.get(bare) ?? { host, global: Infinity, country: Infinity }
  site[key] = Math.min(site[key], rank)
  // The www. address wins over the bare one: it's where the site ends up.
  if (host.startsWith('www.')) site.host = host
  const domain = parents(bare).find((d) => ranks.has(d))
  // Tranco ranks whole domains, so a subdomain takes its domain's rank, well behind the domain's
  // own front page: "ne" is netflix.com before news.google.com.
  site.tranco = !domain ? Infinity : domain === bare ? ranks.get(domain) : ranks.get(domain) * SUBDOMAIN_PENALTY
  sites.set(bare, site)
}
function add(rows, top, key) {
  for (const [origin, rank] of rows) {
    if (rank > top || !origin.startsWith('https://')) continue
    const host = new URL(origin).host
    // As typed: no www., and m. is only the phone version of the same site.
    const bare = host.replace(/^(www|m)\./, '')
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(bare)) continue
    if (ADULT_WORDS.test(bare) || parents(bare).some((d) => blocked.has(d))) continue
    const domain = parents(bare).find((d) => ranks.has(d))
    if (domain && domain !== bare) {
      // en.wikipedia.org is how people visit wikipedia.org, which "wik" should still complete to.
      put(domain, domain, rank, key)
      if (rank > SUBDOMAIN_TOP || /\d/.test(bare.split('.')[0])) continue
    }
    put(bare, host.startsWith('m.') ? bare : host, rank, key)
  }
}
add(global, GLOBAL_TOP, 'global')
add(country, COUNTRY_TOP, 'country')

const bucket = (s) => Math.min(s.country, s.global)
const score = (s) => s.tranco * (s.country < Infinity ? 0.02 : 1) * (s.host.endsWith(`.${COUNTRY}`) ? 0.1 : 1)
const list = [...sites.values()]
  .sort((a, b) => bucket(a) - bucket(b) || score(a) - score(b) || a.host.length - b.host.length)
  .map((s) => [s.host, bucket(s)])
writeFileSync(OUT, `[\n${list.map((s) => JSON.stringify(s)).join(',\n')}\n]\n`)
console.log(`top-sites: ${list.length} sites in ${OUT}`)
