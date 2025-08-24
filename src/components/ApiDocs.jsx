// components/ApiDocs.jsx
import { useEffect, useState } from "react";
import { RedocStandalone } from "redoc";

export default function ApiDocs({
  specUrl = "/specs/polymorphic-payments-api.yaml",
}) {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    // Check for Tailwind/astro `dark` class
    const isDark = document.documentElement.classList.contains("dark");
    setDarkMode(isDark);

    // If your site toggles theme dynamically, you might listen for mutations
    const observer = new MutationObserver(() => {
      setDarkMode(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  return (
    <div style={{ minHeight: "80vh", marginBottom: "2rem" }}>
      <RedocStandalone
        specUrl={specUrl}
        options={{
          theme: {
            logo: { disabled: true },
            branding: { logo: { disabled: true } },
            colors: {
              primary: { main: "#0070f3" },
              text: { primary: darkMode ? "#f5f5f5" : "#1a1a1a" },
              background: { main: darkMode ? "#1e1e1e" : "#ffffff" },
            },
          },
        }}
      />
    </div>
  );
}
