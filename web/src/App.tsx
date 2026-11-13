import { useBridge, useUnauthorized } from "./store";
import { Header } from "./components/Header";
import { Decisions } from "./components/Decisions";
import { Fleet } from "./components/Fleet";
import { Routing } from "./components/Routing";
import { SystemView } from "./components/SystemView";
import { MoonDetail } from "./components/MoonDetail";

export function App() {
  const b = useBridge();
  const unauthorized = useUnauthorized();
  if (unauthorized) {
    return (
      <div className="gate">
        <p className="msg-error">This page was not opened with the owner's access token.</p>
        <p>Open the URL that <code>nexus serve</code> printed in your terminal; it sets the cookie this page needs.</p>
      </div>
    );
  }
  return (
    <div className="shell">
      <Header b={b} />
      <div className="columns">
        <div className="col left"><Decisions b={b} /><Fleet b={b} /><Routing b={b} /></div>
        <div className="col right"><SystemView b={b} /><MoonDetail b={b} /></div>
      </div>
    </div>
  );
}
