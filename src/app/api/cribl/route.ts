import { NextResponse } from 'next/server'

/**
 * POST /api/cribl
 *
 * Server-side proxy for Cribl Stream HEC requests.
 * Accepts a pre-formatted Splunk HEC batch (newline-delimited JSON) plus
 * the destination URL and token, then forwards the request from the server
 * so the browser never hits the Cribl endpoint directly (avoids CORS).
 *
 * Body: { batch: string, url: string, token: string }
 * Returns: { ok: true } on success, or { ok: false, status: number, body: string } on upstream error.
 */
export async function POST(request: Request) {
  let body: { batch: string; url: string; token: string }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const { batch, url, token } = body

  if (!url || !token || !batch) {
    return NextResponse.json(
      { ok: false, error: 'Missing required fields: url, token, batch' },
      { status: 400 },
    )
  }

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Splunk ${token}`,
        'Content-Type': 'application/json',
      },
      body: batch,
    })
  } catch (err) {
    // Network-level error (DNS failure, connection refused, etc.)
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: `Network error: ${message}` }, { status: 502 })
  }

  if (!upstream.ok) {
    const upstreamBody = await upstream.text().catch(() => '')
    return NextResponse.json(
      { ok: false, status: upstream.status, body: upstreamBody.slice(0, 500) },
      { status: upstream.status },
    )
  }

  return NextResponse.json({ ok: true })
}
