from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parents[2]
target = ROOT / 'output/pdf/SF-Workspace-Technical-Guide-v1.0.0.pdf'
appendix = ROOT / 'tmp/pdfs/data-transfer-addendum.pdf'
merged = ROOT / 'tmp/pdfs/SF-Workspace-Technical-Guide-v1.0.0.updated.pdf'

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
    for item in items:
        out += [Paragraph(f'&#8226;&nbsp;&nbsp;{item}', ParagraphStyle(name=f'b{len(out)}', parent=styles['Body2'], leftIndent=9, firstLineIndent=-7, spaceAfter=3))]
    return out

def table(rows, widths):
    t = Table([[P(c, 'Small') for c in row] for row in rows], colWidths=widths, repeatRows=1, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),navy), ('TEXTCOLOR',(0,0),(-1,0),colors.white),
        ('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'), ('VALIGN',(0,0),(-1,-1),'TOP'),
        ('GRID',(0,0),(-1,-1),0.45,line), ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, light]),
        ('LEFTPADDING',(0,0),(-1,-1),5), ('RIGHTPADDING',(0,0),(-1,-1),5),
        ('TOPPADDING',(0,0),(-1,-1),5), ('BOTTOMPADDING',(0,0),(-1,-1),5),
    ]))
    return t

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(line); canvas.line(18*mm, 13*mm, 192*mm, 13*mm)
    canvas.setFont('Helvetica', 7.5); canvas.setFillColor(muted)
    canvas.drawString(18*mm, 8.5*mm, 'SF Workspace Technical Guide | Data Import & Export implementation addendum')
    canvas.drawRightString(192*mm, 8.5*mm, f'Addendum {doc.page}')
    canvas.restoreState()

story = [
    P('Data Import & Export', 'PageTitle'),
    P('IMPLEMENTATION ADDENDUM - supersedes the earlier feature inventory where the new top-level tab was absent.', 'Status'),
    P('<b>Status: Working.</b> Repository verification on 24 September 2026 found a separate top-level <b>Data Import & Export</b> sidebar section with <b>Import</b> and <b>Export</b> subtabs. It is intentionally separate from Records.', 'Body2'),
    P('Component inventory', 'Section'),
    table([
        ['Component', 'Responsibility', 'Primary implementation'],
        ['Route and sidebar', 'Top-level dataTransfer section; Import and Export tools; searchable route metadata.', 'src/sidepanel/state/routes.ts; src/sidepanel/App.tsx'],
        ['Import UI', 'CSV upload, object/operation selection, auto/manual mapping, validation, preview, confirmation, progress, results.', 'src/sidepanel/modules/dataTransfer/DataImport.tsx'],
        ['Export UI', 'Object/field selection, structured filter, preview, paged export, progress, cancel, CSV download.', 'src/sidepanel/modules/dataTransfer/DataExport.tsx'],
        ['Transfer domain helpers', 'RFC 4180-style parsing, type conversion, mapping validation, safe identifiers, CSV encoding.', 'src/shared/salesforce/dataTransfer.ts'],
        ['Salesforce client', 'REST Query, pagination, sObject create/update and external-ID upsert; abort and API limit handling.', 'src/shared/api/client.ts'],
        ['Persistence/download', 'Org-scoped history metadata in IndexedDB; Blob URL downloads. No CSV payload persistence.', 'src/sidepanel/services/platform.ts; utils/download.ts'],
    ], [34*mm, 72*mm, 68*mm]),
    Spacer(1, 5),
    P('Cross-cutting data flow', 'Section'),
    table([
        ['Stage', 'Flow and control'],
        ['Connection', 'ConnectionGate exposes the SalesforceClient and MetadataService for the explicitly selected org. The header identifies that org and user.'],
        ['Authorization', 'Global/object describe limits selectable objects and writable fields. REST and Query APIs execute as the connected user; Salesforce enforces CRUD, FLS, sharing, restriction rules, validation rules, and automation.'],
        ['Memory', 'Uploaded CSV text, parsed rows, previews, transfer records, and generated CSV remain component-memory state. Leaving the tool or changing org discards them.'],
        ['History', 'Only timestamp, object, operation/field count, row counts, result counts, filter presence, and cancellation state are stored under the current org namespace.'],
        ['Download', 'Results are generated locally as escaped CSV and downloaded through a temporary object URL.'],
    ], [33*mm, 141*mm]),
    Spacer(1, 7),
    P('Verification update', 'Section'),
    *bullets([
        '<b>PASS:</b> TypeScript typecheck.',
        '<b>PASS:</b> 14 test files and 149 tests, including four CSV/mapping/validation tests.',
        '<b>PASS:</b> production esbuild output.',
        '<b>Known repository baseline:</b> ESLint still reports five pre-existing browser-global/unused-variable errors in src/sidepanel/theme-boot.js.',
    ]),
    PageBreak(),
    P('Import: components, validation, and writes', 'PageTitle'),
    P('<b>Status: Working.</b> The write path cannot start until local validation succeeds and the user accepts a confirmation dialog.', 'Status'),
    P('User and data flow', 'Section'),
    *bullets([
        '<b>1. Upload:</b> File input accepts CSV. The file is read with File.text(), parsed in memory, and capped at 10,000 data rows. Empty/duplicate headers and unclosed quotes are rejected.',
        '<b>2. Target:</b> Object choices come from global describe and are limited to createable/updateable objects. Insert, Update, and Upsert are explicit operations.',
        '<b>3. Mapping:</b> Headers auto-map by case-insensitive API name or label; each column may be remapped or ignored. Duplicate target fields are rejected.',
        '<b>4. Validation:</b> Conversion checks booleans, numbers, ISO dates, datetimes, text lengths, restricted picklists, writeability, required create fields, Id for Update, and the selected mapped external ID for Upsert.',
        '<b>5. Preview:</b> The first ten converted rows are shown before submission; validation issues include CSV row and field.',
        '<b>6. Confirmation:</b> The modal names the operation, object record count, and connected org/user, and warns that Salesforce rules and automation apply.',
        '<b>7. Execution:</b> Records are processed in client-side batches of 25 with bounded client concurrency. Insert uses POST sObject; Update uses PATCH by Id; Upsert uses PATCH by external-ID field/value.',
        '<b>8. Results:</b> Progress updates after each batch. Every row receives success/id or an error string. A downloadable row-level CSV contains row, success, id, and error.',
    ]),
    P('Salesforce APIs and access enforcement', 'Section'),
    table([
        ['Purpose', 'API / endpoint', 'Enforcement'],
        ['Discover objects', 'REST GET /sobjects/', 'Object visibility and createable/updateable flags are those of the connected user.'],
        ['Discover fields', 'REST GET /sobjects/{object}/describe/', 'Mapping choices use createable/updateable/externalId and other describe attributes.'],
        ['Insert', 'REST POST /sobjects/{object}/', 'Salesforce applies object create access, FLS, requiredness, validation, triggers, Flows, and duplicate rules.'],
        ['Update', 'REST PATCH /sobjects/{object}/{Id}', 'Salesforce applies object update, record access/sharing, FLS, locks, validation, and automation.'],
        ['Upsert', 'REST PATCH /sobjects/{object}/{externalIdField}/{value}', 'Salesforce resolves the external ID and applies create or update authorization and record access.'],
    ], [32*mm, 65*mm, 77*mm]),
    P('Error handling and cancellation', 'Section'),
    *bullets([
        'File and local validation errors block the confirmation button; Salesforce row failures do not stop unrelated rows.',
        'AbortController cancels outstanding fetches. Authentication refresh, typed API errors, network errors, and rate-limit usage tracking remain centralized in SalesforceClient.',
        'Import history is saved only after a completed run and contains aggregate metadata, never source rows or CSV contents.',
    ]),
    PageBreak(),
    P('Export: query, preview, progress, and cancellation', 'PageTitle'),
    P('<b>Status: Working.</b> Export is a separate subtab and runs read-only queries under the connected Salesforce identity.', 'Status'),
    P('User and data flow', 'Section'),
    *bullets([
        '<b>1. Target:</b> Object choices are limited to queryable objects returned by global describe.',
        '<b>2. Fields:</b> Users select readable described fields. Compound address/location containers are omitted; their concrete readable fields remain selectable where exposed.',
        '<b>3. Filter:</b> One structured field/operator/value predicate is supported. Object and field identifiers are allowlisted by describe and validated; string values are SOQL-escaped, numeric and Boolean values are type-checked. Raw SOQL is not accepted.',
        '<b>4. Preview:</b> A LIMIT 20 query displays records before a full export.',
        '<b>5. Export:</b> Query API pages are followed through nextRecordsUrl. Progress reports loaded versus total rows. The current implementation caps one export at 50,000 rows and stops early when known daily API use exceeds 90 percent.',
        '<b>6. Cancel:</b> Cancel aborts in-flight requests. Partial results are deliberately not offered as a download, and history records that the run was cancelled.',
        '<b>7. Download:</b> Completed rows are escaped into CSV locally and downloaded. The generated dataset remains in memory only.',
    ]),
    P('Salesforce APIs, permissions, and record access', 'Section'),
    table([
        ['Concern', 'Implementation'],
        ['Object and field access', 'Global/object describe supplies queryable objects and the connected user-visible field set.'],
        ['Record access', 'REST Query API executes in the connected user context, so sharing, role hierarchy, teams/manual shares, restriction rules, and other platform access controls determine returned rows.'],
        ['Pagination', 'GET /query starts the request; nextRecordsUrl is followed page by page by queryAll.'],
        ['API protection', 'SalesforceClient caps concurrent requests, retries idempotent GETs on 502/503/504, tracks Sforce-Limit-Info, refreshes once after 401, and refuses cross-instance credential use.'],
    ], [43*mm, 131*mm]),
    P('Errors, privacy, and operational limits', 'Section'),
    *bullets([
        'SOQL construction errors surface before the request; Salesforce and network errors use the shared error explanation UI.',
        'Export history is org-scoped aggregate metadata only. Record values, previews, and generated CSV are not written to extension storage.',
        'The current filter builder supports one predicate and six comparison operators. Multi-condition groups, Bulk API 2.0 jobs, resume-after-restart, and exports above 50,000 rows are <b>Planned / not implemented</b>.',
        'The import path uses REST record operations in batches of 25, not Bulk API 2.0. Server-side bulk job monitoring and restart persistence are <b>Planned / not implemented</b>.',
    ]),
    P('Traceability', 'Section'),
    P('Tests: tests/dataTransfer.test.ts. UI: DataImport.tsx and DataExport.tsx. Core helpers: dataTransfer.ts. Client method: SalesforceClient.upsertRecord. Navigation: routes.ts and App.tsx. This addendum reflects the repository after implementation and supersedes any earlier statement in this guide that omits the Data Import & Export section.', 'Small'),
]

doc = SimpleDocTemplate(str(appendix), pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=17*mm, bottomMargin=18*mm, title='SF Workspace Technical Guide - Data Import & Export Addendum')
doc.build(story, onFirstPage=footer, onLaterPages=footer)

writer = PdfWriter()
for page in PdfReader(str(target)).pages:
    writer.add_page(page)
for page in PdfReader(str(appendix)).pages:
    writer.add_page(page)
writer.add_metadata({
    '/Title': 'SF Workspace Technical Guide v1.0.0',
    '/Subject': 'Repository-verified architecture and Data Import & Export implementation',
    '/Author': 'SF Workspace',
})
with merged.open('wb') as fh:
    writer.write(fh)
merged.replace(target)
print(target)
