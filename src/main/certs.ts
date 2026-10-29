import type { Certificate, Session } from 'electron'
import { X509Certificate } from 'node:crypto'
import type { CertInfo, CertView } from '../shared/types'

interface Blocked {
  url: string
  host: string
  error: string
  cert: Certificate
}

/** `net::ERR_CERT_DATE_INVALID` and `CERT_DATE_INVALID` both become `CERT_DATE_INVALID`; OK becomes ''. */
const errorName = (error: string) => {
  const name = error.replace(/^net::/, '').replace(/^ERR_/, '')
  return name === 'OK' ? '' : name
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Chrome won't let you past these either. */
const FATAL = new Set(['CERT_REVOKED', 'SSL_PINNED_KEY_NOT_IN_CERT_CHAIN'])

/**
 * Certificate errors. Electron refuses a bad certificate and leaves a blank page; jbrow notes
 * what was refused so the tab can say why and offer to go ahead anyway.
 */
export class Certificates {
  /** The certificate each host showed this run, per profile, and what Chromium thought of it. */
  private seen = new Map<string, { cert: Certificate; error: string }>()
  /** Profile, host and certificate fingerprint you chose to trust. Forgotten on quit, as in Chrome. */
  private allowed = new Set<string>()
  /** Tabs whose page a certificate stopped. */
  private blocked = new Map<string, Blocked>()
  private chains = new Map<string, CertInfo[]>()

  constructor(private onChange: () => void) {}

  /** Watches every certificate the profile is shown, so trusted sites have details too. */
  attach(sess: Session, profileId: string) {
    sess.setCertificateVerifyProc((req, callback) => {
      this.seen.set(`${profileId}\n${req.hostname}`, { cert: req.validatedCertificate ?? req.certificate, error: errorName(req.verificationResult) })
      // -3: go with Chromium's own verdict.
      callback(-3)
    })
  }

  /** A page's request met a bad certificate. Returns whether to let it through. */
  onError(tabId: string, profileId: string, url: string, error: string, cert: Certificate, isMainFrame: boolean): boolean {
    if (this.trusted(profileId, url, cert)) return true
    if (isMainFrame) {
      this.blocked.set(tabId, { url, host: hostOf(url), error: errorName(error), cert })
      this.onChange()
    }
    return false
  }

  /** You chose to go ahead with this certificate on this site. */
  trusted(profileId: string, url: string, cert: Certificate) {
    return this.allowed.has(`${profileId}\n${hostOf(url)}\n${cert.fingerprint}`)
  }

  /** The tab is going somewhere new, or its page is gone. */
  clear(tabId: string) {
    if (this.blocked.delete(tabId)) this.onChange()
  }

  isBlocked(tabId: string) {
    return this.blocked.has(tabId)
  }

  /** Trusts the certificate that stopped the tab and returns the address to load again. */
  proceed(tabId: string, profileId: string): string | null {
    const b = this.blocked.get(tabId)
    if (!b || FATAL.has(b.error)) return null
    this.allowed.add(`${profileId}\n${b.host}\n${b.cert.fingerprint}`)
    this.blocked.delete(tabId)
    this.onChange()
    return b.url
  }

  /** Stops trusting the host's bad certificates. */
  distrust(profileId: string, host: string) {
    for (const key of this.allowed) if (key.startsWith(`${profileId}\n${host}\n`)) this.allowed.delete(key)
    this.onChange()
  }

  view(tabId: string, profileId: string, url: string): CertView | null {
    const b = this.blocked.get(tabId)
    if (b) return { host: b.host, url: b.url, error: b.error, blocked: true, trusted: false, fatal: FATAL.has(b.error), chain: this.chain(b.cert) }
    if (!/^https:/i.test(url)) return null
    const host = hostOf(url)
    const seen = this.seen.get(`${profileId}\n${host}`)
    if (!seen) return null
    const trusted = this.allowed.has(`${profileId}\n${host}\n${seen.cert.fingerprint}`)
    return { host, url, error: seen.error, blocked: false, trusted, fatal: FATAL.has(seen.error), chain: this.chain(seen.cert) }
  }

  /** The certificate the host showed this run and Chromium's verdict ('' when fine), or null if it wasn't contacted. */
  seenOn(profileId: string, host: string): { cert: Certificate; error: string; trusted: boolean } | null {
    const seen = this.seen.get(`${profileId}\n${host}`)
    if (!seen) return null
    return { ...seen, trusted: this.allowed.has(`${profileId}\n${host}\n${seen.cert.fingerprint}`) }
  }

  /** The site's certificate first, then each one that signed it. */
  private chain(cert: Certificate): CertInfo[] {
    const cached = this.chains.get(cert.fingerprint)
    if (cached) return cached
    const chain: CertInfo[] = []
    const fingerprints = new Set<string>()
    for (let c: Certificate | undefined = cert; c && !fingerprints.has(c.fingerprint) && chain.length < 10; c = c.issuerCert) {
      fingerprints.add(c.fingerprint)
      chain.push(describe(c))
    }
    this.chains.set(cert.fingerprint, chain)
    return chain
  }
}

function describe(c: Certificate): CertInfo {
  let names: string[] = []
  let sha256 = ''
  try {
    const x = new X509Certificate(c.data)
    names = (x.subjectAltName ?? '').split(', ').filter(Boolean).map((n) => n.replace(/^DNS:/, ''))
    sha256 = x.fingerprint256
  } catch {}
  return {
    subject: c.subject.commonName || c.subjectName,
    subjectOrg: [...c.subject.organizations, ...c.subject.organizationUnits].join(', '),
    issuer: c.issuer.commonName || c.issuerName,
    issuerOrg: c.issuer.organizations.join(', '),
    validFrom: c.validStart * 1000,
    validTo: c.validExpiry * 1000,
    serial: c.serialNumber,
    sha256,
    names,
  }
}
