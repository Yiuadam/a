# BandUp — WeChat mini program

A one-page shell that opens <https://bandup.life> inside a `<web-view>`.

## Why a shell and not a port

A mini program is not a browser. Its pages are WXML and its runtime has no
DOM, so this codebase cannot run inside one — it would have to be rewritten
against Taro, uni-app or the raw mini program APIs, and then kept rewritten.

That is the wrong trade here, and not mainly because of the effort. The
content *is* the product and it changes: every new question bank, passage or
study-plan rule would mean a second implementation and another review cycle
before learners in WeChat could see it. A shell shows whatever `bandup.life`
is currently serving, which is the same thing the web and the iOS app show.

What it costs is real and worth stating: everything here depends on the
network, there is no offline mode, and the refractive glass is switched off
inside the shell (see below). If the mini program ever needs to work offline
or feel native, that is the point to reconsider — and it means a port, not a
patch to this.

## Build

```bash
npm run build:miniprogram
```

There is nothing to compile. The script points the shell at a deployment,
checks every file WeChat needs is present, and checks the shell's marker still
matches the one the site looks for. Run it after changing either.

To aim the shell at a preview instead of production:

```bash
MINIPROGRAM_ORIGIN=https://pr-178-bandup.ad1m.workers.dev npm run build:miniprogram
```

## Open it

1. Install **WeChat DevTools** (微信开发者工具).
2. *Import project* → choose this `miniprogram/` folder.
3. Give it the AppID from the WeChat MP console. Leave
   `project.config.json`'s `appid` blank and DevTools will ask, or fill it in
   once and it stops asking.

## Before it will load anything real

`<web-view>` refuses any origin that is not a registered business domain, and
this is the step that catches people out — in DevTools it can be silenced
with *Details → Local settings → 不校验合法域名*, and then it fails only once
it is on a real phone.

In the WeChat MP console, under 开发 → 开发管理 → 开发设置 → 业务域名, add
`bandup.life`. WeChat will give you a verification file to serve from the
site's root before it will accept the domain.

An account also has to be an **unrestricted** account type to use `<web-view>`
at all — individual accounts (个人主体) cannot. If the account is individual,
no amount of configuration will make this work, and that is the thing to find
out first rather than last.

## What the shell tells the site

It opens `…/?shell=miniprogram`. The site reads that (`isMiniProgramShell` in
`lib/platform.ts`) and turns the refractive glass off — the frosted material
stays, only the per-frame displacement lens goes.

That is deliberate. The lens bends what is painted behind it, and inside a
web-view what is behind it is another app's chrome, so it spends compositor
work competing with the host for an effect it cannot actually show. The
marker is also remembered for the session, because only the first page
carries the query string and every link followed from it would otherwise look
like an ordinary browser again.

## Deep links

The page accepts a `path` query parameter, so a share or a scene value can
open BandUp somewhere other than the home page:

```
pages/index/index?path=/writing
```

Anything that is not a simple absolute path is ignored and the shell opens
`/` — a value arriving from a share link is not trusted, and `//evil.example`
is a protocol-relative URL that would send the web-view off-site entirely.
