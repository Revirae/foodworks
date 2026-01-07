import { Head } from "$fresh/runtime.ts";
import Workspace from "../islands/Workspace.tsx";

export default function Home() {
  return (
    <>
      <Head>
        <title>Food Manufacturing DAG App</title>
        <link rel="stylesheet" href="/styles.css" />
      </Head>
      <div class="container">
        <header
          style={{
            marginBottom: "0.75rem",
            padding: "0.5rem 0",
            background: "#374151",
            borderRadius: "6px",
            textAlign: "center",
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: "1.25rem",
              fontWeight: 600,
              letterSpacing: "0.05em",
              color: "#e5e7eb",
              textTransform: "uppercase",
            }}
          >
            Food Manufacturing DAG App
          </h1>
        </header>

        <Workspace />
      </div>
    </>
  );
}

