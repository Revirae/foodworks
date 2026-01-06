import { type AppProps } from "$fresh/server.ts";
import { Head } from "$fresh/runtime.ts";
import { getAppSettings } from "../utils/appSettings.ts";

export default function App({ Component }: AppProps) {
  const settings = getAppSettings();
  
  return (
    <>
      <Head>
        <script
          dangerouslySetInnerHTML={{
            __html: `globalThis.__APP_SETTINGS__ = ${JSON.stringify(settings)};`,
          }}
        />
      </Head>
      <Component />
    </>
  );
}
