export function createAmenityPopup(feature) {
  const p = feature.properties || {};
  const type = p.amenity || "unknown";

  // Build address string if available
  const addressParts = [
    p["addr:street"],
    p["addr:housenumber"],
    p["addr:postcode"],
    p["addr:city"],
  ].filter(Boolean);
  const address = addressParts.length ? addressParts.join(", ") : null;

  const row = (label, value, isLink = false) =>
    value
      ? `<div><b>${label}:</b> ${
          isLink ? `<a href="${value}" target="_blank">${value}</a>` : value
        }</div>`
      : "";

  // Shared content across all amenities
  let html = `<div style="min-width:200px;">
    <h3 style="margin:4px 0;">${p.name || p.brand || "Unnamed " + type}</h3>
    ${address ? `<div>${address}</div>` : ""}
    ${row("Opening hours", p.opening_hours)}
    ${row("Phone", p.phone || p["contact:phone"])}
    ${row("Website", p.website, true)}
    ${row("Wheelchair", p.wheelchair)}
  `;

  // Type-specific extras
  switch (type) {
    case "post_office":
      html += `
        ${row("Post Office Type", p["post_office:type"])}
        ${row("Brand", p["brand"] || p["post_office:brand"])}
        ${row("Hermes Ref", p["ref:Hermes"])}
        ${row("Shop Type", p["shop"])}
      `;
      break;

    case "bar":
      html += `
        ${row("Indoor Seating", p.indoor_seating)}
        ${row("Outdoor Seating", p.outdoor_seating)}
        ${row("Start Date", p.start_date)}
      `;
      break;

    case "pub":
      html += `
        ${row("Indoor Seating", p.indoor_seating)}
        ${row("Outdoor Seating", p.outdoor_seating)}
        ${row("Smoking", p.smoking)}
        ${row("Toilets", p.toilets)}
      `;
      break;

    case "restaurant":
      html += `
        ${row("Phone", p.phone)}
        ${row("Wheelchair Toilet", p["toilets:wheelchair"])}
      `;
      break;

    case "cafe":
      html += `
        ${row("Cuisine", p.cuisine)}
        ${row("Vegan Options", p["diet:vegan"])}
        ${row("Internet Access", p.internet_access)}
        ${row("Takeaway", p.takeaway)}
      `;
      break;
  }

  html += `</div>`;
  return html;
}
