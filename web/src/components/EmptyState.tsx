export function EmptyState() {
  return (
    <section className="empty-state">
      <div>
        <p className="section-note">Your first run takes two lines.</p>
        <h1>Keep the experiment.<br />Skip the account.</h1>
      </div>
      <pre aria-label="Python quickstart"><code><span>import</span> oplogs{`\n`}run = oplogs.init(project=<em>"vision-lab"</em>)</code></pre>
      <div className="empty-details">
        <p>The local dashboard opens once and immediately records system, GPU, source, environment, logs, framework events, and failures.</p>
        <p>Custom values use <code>run.log({'{'}"loss": loss{'}'})</code>.</p>
      </div>
    </section>
  )
}
