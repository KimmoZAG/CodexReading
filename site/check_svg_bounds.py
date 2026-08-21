import xml.etree.ElementTree as ET, os, glob

NS = {'svg': 'http://www.w3.org/2000/svg'}

for fpath in sorted(glob.glob('assets/diagrams/*.svg')):
    tree = ET.parse(fpath)
    root = tree.getroot()
    vw = float(root.attrib.get('viewBox').split()[2])
    vh = float(root.attrib.get('viewBox').split()[3])

    issues = []

    # Check all rect elements are within viewBox (with 15px margin)
    for rect in root.iter('{http://www.w3.org/2000/svg}rect'):
        x = float(rect.attrib.get('x', 0))
        y = float(rect.attrib.get('y', 0))
        w = float(rect.attrib.get('width', 0))
        h = float(rect.attrib.get('height', 0))
        if x < -5 or y < -5 or x+w > vw+5 or y+h > vh+5:
            issues.append(f'rect OOB: x={x} y={y} w={w} h={h}')

    # Check text elements are within viewBox (with 10px margin)
    for t in root.iter('{http://www.w3.org/2000/svg}text'):
        x = float(t.attrib.get('x', 0))
        y = float(t.attrib.get('y', 0))
        if x < 0 or x > vw or y < 10 or y > vh-5:
            issues.append(f'text near edge: x={x} y={y}')

    # Check line endpoints are reasonable (not wildly outside)
    for line in root.iter('{http://www.w3.org/2000/svg}line'):
        x1 = float(line.attrib.get('x1', 0)); y1 = float(line.attrib.get('y1', 0))
        x2 = float(line.attrib.get('x2', 0)); y2 = float(line.attrib.get('y2', 0))
        if x1 < -20 or x1 > vw+20 or x2 < -20 or x2 > vw+20:
            issues.append(f'line endpoint far: ({x1},{y1})→({x2},{y2})')

    status = 'PASS' if not issues else f'ISSUES({len(issues)})'
    print(f'{os.path.basename(fpath):30s} view={vw:.0f}x{vh:.0f} {status}')
    for iss in issues:
        print(f'  ! {iss}')
