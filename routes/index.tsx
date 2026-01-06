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
        <header style={{ marginBottom: "1rem", padding: "1rem 0", borderBottom: "2px solid #e5e7eb" }}>
          <h1 style={{ margin: 0, fontSize: "2rem", fontWeight: 700, color: "#1f2937" }}>
            Food Manufacturing DAG App
          </h1>
          <p style={{ margin: "0.5rem 0 0 0", color: "#6b7280", fontSize: "0.875rem" }}>
            Manage ingredients, recipes, products, and production workflows
          </p>
        </header>

        <Workspace />
      </div>
    </>
  );
}

