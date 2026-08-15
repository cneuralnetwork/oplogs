export function EmptyState() {
  return (
    <section className="empty-state">
      <div>
        <p className="section-note">your first run takes two lines.</p>
        <h1>keep the experiment.<br />skip the account.</h1>
      </div>
      <pre aria-label="python quickstart"><code><span>import</span> oplogs{`\n`}run = oplogs.init(project=<em>"vision-lab"</em>)</code></pre>
      <div className="empty-details">
        <p>the local dashboard opens once and immediately records system, gpu, source, environment, logs, framework events, and failures.</p>
        <p>custom values use <code>run.log({'{'}"loss": loss{'}'})</code>.</p>
      </div>
    </section>
  )
}
