import { T } from '../text.ts'

export function NotFound() {
  return (
    <div class="state" data-state="not-found">
      <h1 class="title">{T.notFound.title}</h1>
      <p>{T.notFound.lead}</p>
      <a class="button" href="/">
        {T.notFound.home}
      </a>
    </div>
  )
}
