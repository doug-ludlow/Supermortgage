// Transcribed from docs/prototype/Supermortgage-Agent-Prototype.html (the second <script> block).
// Every string is verbatim. Regenerate rather than edit.

import Foundation

/// `ARTS` and `MEDIA` in the prototype.
enum ArtifactFixtures {
    static let artifacts: [Artifact] = [
        Artifact(id: .dash, title: "Housing cost dashboard", subtitle: "Live · updates with every move", live: true),
        Artifact(id: .refi, title: "Refinance comparison", subtitle: "6.125% today vs 5.75% offered", live: false),
        Artifact(id: .audit, title: "Statement audit — September", subtitle: "3 checks · 1 finding", live: false),
        Artifact(id: .pmi, title: "PMI cancellation request", subtitle: "Draft — waiting for your yes", live: false),
        Artifact(id: .ins, title: "Insurance quotes", subtitle: "Starts Feb 1 · 5 carriers", live: false),
        Artifact(id: .site, title: "Compute site assessment", subtitle: "Scheduled Sep 24", live: false),
        Artifact(id: .tax, title: "Assessment appeal packet", subtitle: "Waiting for the window · Jul 2027", live: false),
    ]

    static let media: [MediaItem] = [
        MediaItem(title: "Mortgage statement · Sep 2026", kind: .file),
        MediaItem(title: "Title-lock cancellation receipt", kind: .camera),
        MediaItem(title: "Home warranty cancellation receipt", kind: .camera),
    ]
}
