from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parents[2]
target = ROOT / 'output/pdf/SF-Workspace-Technical-Guide-v1.0.0.pdf'
appendix = ROOT / 'tmp/pdfs/apex-flow-explorer-addendum.pdf'
merged = ROOT / 'tmp/pdfs/SF-Workspace-Technical-Guide-v1.0.0.explorer-updated.pdf'

navy = colors.HexColor('#17324D')
blue = colors.HexColor('#1B6CA8')
light = colors.HexColor('#EAF3F9')
ink = colors.HexColor('#17212B')
muted = colors.HexColor('#536474')
line = colors.HexColor('#C9D5DF')
green = colors.HexColor('#18794E')

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='PageTitle', parent=styles['Heading1'], fontName='Helvetica-Bold', fontSize=20, leading=24, textColor=navy, spaceAfter=10))
styles.add(ParagraphStyle(name='Section', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=12.5, leading=15, textColor=navy, spaceBefore=8, spaceAfter=5))
styles.add(ParagraphStyle(name='Body2', parent=styles['BodyText'], fontName='Helvetica', fontSize=8.8, leading=12, textColor=ink, spaceAfter=4))
styles.add(ParagraphStyle(name='Small', parent=styles['BodyText'], fontName='Helvetica', fontSize=7.7, leading=10, textColor=muted))
styles.add(ParagraphStyle(name='Status', parent=styles['BodyText'], fontName='Helvetica-Bold', fontSize=9, textColor=green, backColor=colors.HexColor('#E8F6EF'), borderPadding=5, spaceAfter=8))

def P(text, style='Body2'):
    return Paragraph(text, styles[style])

def bullets(items):
    out = []
    for i, item in enumerate(items):
        style = ParagraphStyle(name=f'explorer_bullet_{i}_{len(out)}', parent=styles['Body2'], leftIndent=9, firstLineIndent=-7, spaceAfter=3)
        out.append(Paragraph(f'&#8226;&nbsp;&nbsp;{item}', style))
    return out

def table(rows, widths):
    t = Table([[P(c, 'Small') for c in row] for row in rows], colWidths=widths, repeatRows=1, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), navy), ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'), ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('GRID', (0,0), (-1,-1), 0.45, line), ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, light]),
        ('LEFTPADDING', (0,0), (-1,-1), 5), ('RIGHTPADDING', (0,0), (-1,-1), 5),
        ('TOPPADDING', (0,0), (-1,-1), 5), ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ]))
    return t

def footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(colors.white)
    canvas.rect(0, 0, A4[0], A4[1], fill=1, stroke=0)
    canvas.setStrokeColor(line); canvas.line(18*mm, 13*mm, 192*mm, 13*mm)
    canvas.setFont('Helvetica', 7.5); canvas.setFillColor(muted)
    canvas.drawString(18*mm, 8.5*mm, 'SF Workspace Technical Guide | Apex & Flow Explorer implementation addendum')
    canvas.drawRightString(192*mm, 8.5*mm, f'Explorer {doc.page}')
    canvas.restoreState()

story = [
    P('Apex & Flow Explorer', 'PageTitle'),
    P('IMPLEMENTATION ADDENDUM - top-level metadata explanation workspace.', 'Status'),
    P('<b>Status: Working.</b> The sidebar contains a dedicated <b>Apex & Flow Explorer</b> section with route-backed <b>Apex Classes</b>, <b>Apex Triggers</b>, and <b>Flows</b> subtabs. It reuses and expands the former Code & Automation Explainer.', 'Body2'),
    P('Component and route inventory', 'Section'),
    table([
        ['Component', 'Responsibility', 'Implementation'],
        ['Navigation', 'Top-level apexFlow section, three searchable tools, route history, deep link by explorerName.', 'src/sidepanel/state/routes.ts; src/sidepanel/App.tsx'],
        ['Explorer UI', 'Responsive master-detail browser, search, Flow version picker, refresh, copy, source/metadata panel, handler links.', 'src/sidepanel/modules/development/CodeExplainer.tsx'],
        ['Local analyzers', 'Apex/trigger structural parsing, line references, dependency detection, Flow element grouping and connector path.', 'src/shared/development/codeExplainer.ts'],
        ['API and cache', 'Tooling queries and sObject reads through SalesforceClient; org-scoped definition cache in IndexedDB.', 'src/shared/api/client.ts; services/platform.ts'],
        ['Shared UI', 'ConnectionGate, theme tokens, loading/error/empty states, buttons, pills, focus and responsive behavior.', 'src/sidepanel/components; src/sidepanel/styles.css'],
    ], [31*mm, 76*mm, 67*mm]),
    Spacer(1, 6),
    P('Common data flow and privacy', 'Section'),
    *bullets([
        '<b>1. Select org:</b> Workspace context exposes the explicitly selected connected org. Changing org remounts the tool and changes the storage namespace.',
        '<b>2. List metadata:</b> Tooling Query returns only classes, triggers, and Flow versions visible to the connected Salesforce user.',
        '<b>3. Retrieve definition:</b> Tooling sObject GET retrieves Body for Apex or Metadata for the selected Flow version.',
        '<b>4. Explain locally:</b> Deterministic parsers inspect structural markers. No source or metadata is sent to an AI service or any non-Salesforce host.',
        '<b>5. Cache:</b> Results use code-explainer:{type}:{id}:{lastModified-or-version} inside the current org IndexedDB namespace. Refresh bypasses the cache.',
        '<b>6. Verify:</b> Users can inspect and copy the original source or metadata and compare it with cited methods, lines, or Flow element names.',
    ]),
    P('Salesforce API surface', 'Section'),
    table([
        ['Purpose', 'Tooling API operation'],
        ['List classes', 'SELECT Id, Name, Status, ApiVersion, LastModifiedDate FROM ApexClass ORDER BY Name'],
        ['List triggers', 'SELECT Id, Name, Status, TableEnumOrId, ApiVersion, LastModifiedDate FROM ApexTrigger ORDER BY Name'],
        ['List Flow versions', 'SELECT Id, MasterLabel, FullName, Status, VersionNumber, ProcessType, LastModifiedDate FROM Flow ORDER BY MasterLabel, VersionNumber DESC'],
        ['Retrieve definition', 'GET /tooling/sobjects/ApexClass/{id}, ApexTrigger/{id}, or Flow/{id} under the negotiated REST API version.'],
    ], [45*mm, 129*mm]),
    PageBreak(),
    P('Apex Classes and Apex Triggers', 'PageTitle'),
    P('Apex Classes', 'Section'),
    *bullets([
        'Search covers name and status. Selecting a class retrieves Body and shows it in a scrollable, copyable source panel.',
        'The summary identifies visible methods and inputs. Expandable sections cover execution markers, SOQL/read objects, DML/write markers, callouts and async work, explicit error handling, and dependencies.',
        'References include method names and one-based source line numbers for identifiable declarations and operations.',
        'Dependencies are inferred from class-qualified calls. Platform built-ins are filtered, but dynamic dispatch and reflection can hide relationships.',
    ]),
    P('Apex Triggers', 'Section'),
    *bullets([
        'The trigger declaration parser identifies the sObject and declared before/after events and summarizes when the trigger runs.',
        'SOQL, DML, callout/async, and error-handling sections reuse the Apex structural analyzer.',
        'Class-qualified references are presented as possible handler classes. Each handler is a link to the Apex Classes subtab using explorerName; retrieval still succeeds only when the user can access that class.',
        'If a declaration or behavior cannot be confidently recognized, the UI displays an Uncertain label and preserves the original source for verification.',
    ]),
    P('Interpretation boundaries', 'Section'),
    table([
        ['Reported directly', 'Inferred or potentially incomplete'],
        ['Names, status, API version metadata, trigger object/events, source text, explicit SOQL/DML/callout/try-catch markers.', 'Business purpose, effects hidden behind called code, dynamic SOQL, reflection, dependency injection, managed-package internals, runtime branch outcomes.'],
        ['Method names and cited source lines.', 'A class-qualified reference is a likely dependency; it is not proof that the path executes in every transaction.'],
    ], [87*mm, 87*mm]),
    P('Error and permission behavior', 'Section'),
    *bullets([
        'ConnectionGate blocks retrieval without a selected connected org. Salesforce authorization controls list and body visibility.',
        'Typed authentication, permission, network, cancellation, limit, and server errors use the shared ErrorAlert behavior. Refresh retries the selected definition.',
        'An inaccessible handler remains a navigation attempt that resolves to no accessible class rather than exposing hidden source.',
    ]),
    PageBreak(),
    P('Flows: versions, explanation, and visual path', 'PageTitle'),
    P('<b>Status: Working.</b> Flows are grouped by name without discarding versions. Users explicitly select the version to retrieve and explain.', 'Status'),
    P('Version and metadata behavior', 'Section'),
    *bullets([
        'The list shows Flow type and version count. The version picker shows version number, Active/Draft status, and ProcessType.',
        'The selected Flow record is retrieved from the Tooling API. The parser reads the returned Metadata object when present and preserves the full retrieved record otherwise.',
        'Expandable sections identify start conditions, input variables, decisions, assignments, record lookups/creates/updates/deletes, actions, subflows, screens, waits, and pauses by element name.',
        'Element counts and names are structural facts. Meaning that depends on formulas, expressions, runtime data, or unsupported elements is not stated as certain.',
    ]),
    P('Visual path algorithm', 'Section'),
    *bullets([
        'The renderer reads start.connector.targetReference and follows each supported element connector in order.',
        'Each node shows the Flow element name and collection type. faultConnector targets are shown on the originating node.',
        'Traversal is cycle-safe and capped at 100 connected nodes. Remaining recognized but unreachable elements are appended so they are not silently omitted.',
        'The diagram is intentionally a compact horizontal path, not a replacement for Flow Builder. Branch labels, complex loops, scheduled paths, and every outcome connector are not fully modeled.',
    ]),
    P('Testing and verification', 'Section'),
    table([
        ['Check', 'Result'],
        ['Static checks', 'TypeScript and ESLint pass.'],
        ['Automated tests', '17 files and 158 tests pass, including class parsing, trigger handler/timing, active and inactive Flow versions, and connector/fault path generation.'],
        ['Production build', 'esbuild produces dist/sidepanel.js and dist/background.js.'],
        ['Live-org dependency', 'End-to-end metadata coverage depends on the connected user permissions and the exact Tooling Metadata shape returned by that Salesforce API version.'],
    ], [42*mm, 132*mm]),
    P('Limitations', 'Section'),
    P('The explainer is deterministic and local, not semantic AI. It does not execute Apex or Flows, calculate runtime formulas, guarantee dependency completeness, or prove side effects hidden behind inaccessible code. Unsupported Flow elements remain visible in the raw metadata. The current visual path is connector-based and linearized; use Salesforce Flow Builder for the authoritative full graph.', 'Body2'),
]

doc = SimpleDocTemplate(str(appendix), pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=17*mm, bottomMargin=18*mm, title='SF Workspace Technical Guide - Apex & Flow Explorer Addendum')
doc.build(story, onFirstPage=footer, onLaterPages=footer)

writer = PdfWriter()
existing = PdfReader(str(target))
base_pages = list(existing.pages)
if len(base_pages) >= 3 and 'Apex & Flow Explorer implementation addendum' in (base_pages[-1].extract_text() or ''):
    base_pages = base_pages[:-3]
for page in base_pages:
    writer.add_page(page)
for page in PdfReader(str(appendix)).pages:
    writer.add_page(page)
writer.add_metadata({
    '/Title': 'SF Workspace Technical Guide v1.0.0',
    '/Subject': 'Repository-verified architecture, Data Import & Export, and Apex & Flow Explorer implementation',
    '/Author': 'SF Workspace',
})
with merged.open('wb') as stream:
    writer.write(stream)
merged.replace(target)
print(target)
