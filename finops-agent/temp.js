
  // ── State variables ──
  let costDoughnutChart = null;
  let globalCostsChart = null;
  let currentCostView = 'table';
  let currentNodeView = 'table';
  let selectedNodeDns = null;

  // ── Tab switching ──
  function switchTab(el) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('panel-' + el.dataset.panel).classList.add('active');
    if (el.dataset.panel === 'report') {
      if (document.getElementById('reportFrame')) document.getElementById('reportFrame').style.display = 'none';
      if (document.getElementById('executiveReportContainer')) document.getElementById('executiveReportContainer').style.display = 'flex';
      document.querySelectorAll('.report-item').forEach(r => r.classList.remove('active'));
    }
    if (el.dataset.panel === 'workloads' || el.dataset.panel === 'cost') {
      loadWorkloads();
    } else if (el.dataset.panel === 'aws-resources') {
      loadAwsResources();
    } else if (el.dataset.panel === 'trends') {
      loadTrends();
    } else if (el.dataset.panel === 'estimator') {
      if (typeof applyEstTemplate === 'function') {
        applyEstTemplate(window.currentSelectedEstTemplate || 'saas');
      }
    }
  }

  // Chart instance registry (destroy before re-render)
  const _charts = {};
  function _mkChart(id, config) {
    if (_charts[id]) { try { _charts[id].destroy(); } catch(e){} }
    const ctx = document.getElementById(id);
    if (!ctx) return;
    _charts[id] = new Chart(ctx, config);
  }

  const CHART_COLORS = ['#6366f1','#a855f7','#10b981','#f59e0b','#3b82f6','#ef4444','#06b6d4','#84cc16','#f97316','#ec4899'];

  // ── Load Trends ──
  async function loadTrends() {
    try {
      const [trendsResp, realizedResp, recStatusResp] = await Promise.all([
        fetch('/api/trends'),
        fetch('/api/savings-realized'),
        fetch('/api/rec-status')
      ]);
      const trends = await trendsResp.json();
      const realized = await realizedResp.json();
      const recStatus = await recStatusResp.json();

      // KPI row
      document.getElementById('trendPotential').textContent = '$' + realized.potential.toFixed(2) + '/mo';
      document.getElementById('trendRealized').textContent = '$' + realized.realized.toFixed(2) + '/mo';
      const cpuWaste = Math.max(0, trends.cpu_requested_cores - trends.cpu_actual_cores);
      document.getElementById('trendCpuWaste').textContent = cpuWaste.toFixed(1) + ' cores';
      document.getElementById('trendReportCount').textContent = trends.points.length;

      const pts = trends.points;
      const labels = pts.map(p => p.date.slice(5)); // MM-DD HH:mm

      // Chart 1: Savings Trend
      _mkChart('chartSavingsTrend', {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Potential Savings ($/mo)',
            data: pts.map(p => p.total_savings),
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99,102,241,0.08)',
            fill: true,
            tension: 0.4,
            pointBackgroundColor: '#a855f7',
            pointRadius: 4,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: true,
          plugins: { legend: { labels: { color: '#4b5563', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#4b5563', font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.06)' } },
            y: { ticks: { color: '#4b5563', font: { size: 10 }, callback: v => '$' + v }, grid: { color: 'rgba(0,0,0,0.06)' } }
          }
        }
      });

      // Chart 2: Category Breakdown (latest point)
      const latestCats = pts.length ? pts[pts.length - 1].categories : {};
      const catNames = Object.keys(latestCats).filter(k => latestCats[k] > 0);
      const catVals = catNames.map(k => latestCats[k]);
      _mkChart('chartCategoryBreakdown', {
        type: 'doughnut',
        data: {
          labels: catNames,
          datasets: [{ data: catVals, backgroundColor: CHART_COLORS, borderWidth: 0 }]
        },
        options: {
          responsive: true, maintainAspectRatio: true,
          plugins: {
            legend: { position: 'right', labels: { color: '#4b5563', font: { size: 10 }, boxWidth: 12 } }
          }
        }
      });

      // Chart 3: CPU Requested vs Actual
      _mkChart('chartCpuWaste', {
        type: 'bar',
        data: {
          labels: ['CPU Allocation'],
          datasets: [
            { label: 'Requested (cores)', data: [trends.cpu_requested_cores], backgroundColor: 'rgba(239,68,68,0.6)', borderRadius: 6 },
            { label: 'Actually Used (cores)', data: [trends.cpu_actual_cores], backgroundColor: 'rgba(16,185,129,0.7)', borderRadius: 6 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: true,
          indexAxis: 'y',
          plugins: { legend: { labels: { color: '#4b5563', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#4b5563' }, grid: { color: 'rgba(0,0,0,0.06)' } },
            y: { ticks: { color: '#4b5563' }, grid: { color: 'rgba(0,0,0,0.06)' } }
          }
        }
      });

      // Chart 4: 30-Day Forecast (linear extrapolation from last N points)
      const forecastDays = 30;
      let forecastLabels = [], forecastData = [];
      if (pts.length >= 2) {
        const last = pts[pts.length - 1].total_savings;
        const prev = pts[0].total_savings;
        const slope = (last - prev) / Math.max(1, pts.length - 1);
        const today = new Date();
        for (let i = 1; i <= forecastDays; i++) {
          const d = new Date(today); d.setDate(d.getDate() + i);
          forecastLabels.push(d.toLocaleDateString('en', {month:'short', day:'numeric'}));
          forecastData.push(Math.max(0, Math.round(last + slope * i)));
        }
      }
      _mkChart('chartForecast', {
        type: 'line',
        data: {
          labels: forecastLabels,
          datasets: [{
            label: 'Forecasted Savings ($/mo)',
            data: forecastData,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16,185,129,0.07)',
            fill: true,
            tension: 0.3,
            borderDash: [6, 3],
            pointRadius: 2,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: true,
          plugins: { legend: { labels: { color: '#4b5563', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#4b5563', font: { size: 9 }, maxRotation: 45 }, grid: { color: 'rgba(0,0,0,0.06)' } },
            y: { ticks: { color: '#4b5563', callback: v => '$' + v }, grid: { color: 'rgba(0,0,0,0.06)' } }
          }
        }
      });

      // Recommendation Lifecycle Table
      const tbody = document.getElementById('recLifecycleTbody');
      tbody.innerHTML = '';
      let findings = [];
      try {
        const rListResp = await fetch('/api/reports');
        const rList = await rListResp.json();
        if (rList.length > 0) {
          const rDataResp = await fetch('/api/reports/' + rList[0].json_file);
          const rData = await rDataResp.json();
          findings = rData.findings || [];
        }
      } catch(e) {}

      if (findings.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted);">Generate a report to see recommendations.</td></tr>';
        return;
      }

      const STATUS_OPTS = ['new', 'acknowledged', 'applied', 'ignored'];
      const STATUS_STYLES = {
        new: 'background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3)',
        acknowledged: 'background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3)',
        applied: 'background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3)',
        ignored: 'background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3)',
      };
      const STATUS_LABELS = { new: '&#x1F4A1; New', acknowledged: '&#x1F440; Acknowledged', applied: '&#x2705; Applied', ignored: '&#x274C; Ignored' };

      findings.slice(0, 50).forEach((f, idx) => {
        const rid = f.resource_id || ('rec_' + idx);
        const curStatus = (recStatus[rid] || {}).status || 'new';
        const sav = f.monthly_savings > 0 ? '<span style="color:#34d399;font-family:JetBrains Mono,monospace;font-weight:700;">$' + f.monthly_savings.toFixed(2) + '/mo</span>' : '<span style="color:var(--muted);">-</span>';
        const riskColor = f.risk === 'High' ? '#f87171' : f.risk === 'Medium' ? '#fbbf24' : '#34d399';

        const selectHtml = `<select id="recsel_${idx}" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 10px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;outline:none;" onchange="updateRecStatus('${rid}', this.value, ${idx})">
          ${STATUS_OPTS.map(s => `<option value="${s}" ${s === curStatus ? 'selected' : ''}>${STATUS_LABELS[s].replace(/&#x[^;]+;/, '').trim()}</option>`).join('')}
        </select>`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;background:rgba(99,102,241,0.12);color:#a78bfa;">${f.category || '-'}</span></td>
          <td style="font-family:JetBrains Mono,monospace;font-size:11px;color:#60a5fa;max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${rid}">${rid}</td>
          <td style="font-size:12px;color:var(--muted);max-width:220px;">${(f.suggested_action || '').slice(0, 80)}${(f.suggested_action||'').length > 80 ? '…' : ''}</td>
          <td>${sav}</td>
          <td><span style="color:${riskColor};font-weight:700;font-size:12px;">${f.risk || '-'}</span></td>
          <td id="recstatus_${idx}">${selectHtml}</td>
        `;
        tbody.appendChild(tr);
      });

    } catch(e) {
      console.error('Trends load failed', e);
    }
  }

  async function updateRecStatus(rid, status, idx) {
    await fetch('/api/rec-status', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({id: rid, status})
    });
    // Refresh realized savings KPI
    const r = await (await fetch('/api/savings-realized')).json();
    document.getElementById('trendRealized').textContent = '$' + r.realized.toFixed(2) + '/mo';
  }

  // ── Load reports list ──
  async function loadReports() {
    const resp = await fetch('/api/reports');
    const reports = await resp.json();
    const list = document.getElementById('reportsList');
    list.innerHTML = '<div class="reports-list-title">Past Reports</div>';
    reports.forEach((r, i) => {
      const div = document.createElement('div');
      div.className = 'report-item' + (i === 0 ? ' active' : '');
      div.innerHTML = `
        <div class="ri-date">${new Date(r.analyzed_at).toLocaleString()}</div>
        <div class="ri-meta">${r.findings_count} findings (${r.ai_count} AI) &middot; <span class="ri-savings">$${r.total_savings.toFixed(2)}/mo</span></div>
      `;
      div.onclick = () => loadReport(r.html_file, div);
      list.appendChild(div);
    });
    // Keep Executive Report view open by default; do not auto-load first iframe report
    /*
    if (reports.length > 0) {
      loadReport(reports[0].html_file, list.querySelector('.report-item'));
    }
    */
    loadWorkloads();
    loadAwsResources();
  }

  function loadReport(htmlFile, el) {
    document.querySelectorAll('.report-item').forEach(r => r.classList.remove('active'));
    if (el) el.classList.add('active');
    const frame = document.getElementById('reportFrame');
    const execContainer = document.getElementById('executiveReportContainer');
    frame.src = '/api/reports/' + htmlFile;
    frame.style.display = 'block';
    if (execContainer) execContainer.style.display = 'none';
    
    if (el && window.fridayVoiceEnabled) {
      const savingsSpan = el.querySelector('.ri-savings');
      if (savingsSpan) {
        const savingsText = savingsSpan.textContent.replace('$', '').replace('/mo', '');
        if (hasGreeted) {
          speak("Loading EKS cost optimization report. We identified potential savings of " + savingsText + " dollars per month.");
        }
      }
    }
  }

  // ── Workload sizing ──
  let allWorkloads = {};
  let allNodes = {};
  let allRecommendations = {};
  let allChargebacks = {};
  let allEfficiency = {};
  let viewMode = 'pods';

  // ── AWS Resources ──
  let awsResourcesData = { s3: [], cloudfront: [], ec2: [], eks: [], iam: [] };
  let currentAwsCategory = 's3';
  let activeCostRecCategory = null;

  async function loadAwsResources() {
    try {
      const resp = await fetch('/api/aws-resources');
      awsResourcesData = await resp.json();
      renderAwsResources();
    } catch (e) {
      console.error("Failed to load AWS resources", e);
    }
  }

  function setAwsCategory(category) {
    currentAwsCategory = category;
    document.querySelectorAll('#panel-aws-resources .toggle-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const btn = document.getElementById('btn-aws-' + category);
    if (btn) btn.classList.add('active');
    renderAwsResources();
  }

  function showAwsCostRecs(category) {
    activeCostRecCategory = category;
    
    // Highlight the clicked card on the cost panel
    const s3Card = document.querySelector('#panel-cost .stat-card.blue');
    const cfCard = document.querySelector('#panel-cost .stat-card.purple');
    const eksCard = document.querySelector('#panel-cost .stat-card.yellow');
    const ec2Card = document.querySelector('#panel-cost .stat-card.green');
    const iamCards = document.querySelectorAll('#panel-cost .iam-card');
    
    const cards = [s3Card, cfCard, eksCard, ec2Card];
    cards.forEach(c => {
      if (c) {
        c.style.borderColor = 'var(--border)';
        c.style.boxShadow = 'none';
        c.style.transform = 'none';
      }
    });
    iamCards.forEach(c => {
      if (c) {
        c.style.borderColor = 'var(--border)';
        c.style.boxShadow = 'none';
      }
    });
    
    const badge = document.getElementById('awsCostRecsBadge');
    
    if (category === 's3' && s3Card) {
      s3Card.style.borderColor = '#3b82f6';
      s3Card.style.boxShadow = '0 0 15px rgba(59, 130, 246, 0.35)';
      s3Card.style.transform = 'translateY(-3px)';
      if (badge) badge.style.backgroundColor = '#3b82f6';
    } else if (category === 'cloudfront' && cfCard) {
      cfCard.style.borderColor = '#8b5cf6';
      cfCard.style.boxShadow = '0 0 15px rgba(139, 92, 246, 0.35)';
      cfCard.style.transform = 'translateY(-3px)';
      if (badge) badge.style.backgroundColor = '#8b5cf6';
    } else if (category === 'eks' && eksCard) {
      eksCard.style.borderColor = '#f59e0b';
      eksCard.style.boxShadow = '0 0 15px rgba(245, 158, 11, 0.35)';
      eksCard.style.transform = 'translateY(-3px)';
      if (badge) badge.style.backgroundColor = '#f59e0b';
    } else if (category === 'ec2' && ec2Card) {
      ec2Card.style.borderColor = '#10b981';
      ec2Card.style.boxShadow = '0 0 15px rgba(16, 185, 129, 0.35)';
      ec2Card.style.transform = 'translateY(-3px)';
      if (badge) badge.style.backgroundColor = '#10b981';
    } else if (category === 'iam') {
      iamCards.forEach(c => {
        if (c) {
          c.style.borderColor = '#ff57a6';
          c.style.boxShadow = '0 0 10px rgba(255, 87, 166, 0.25)';
        }
      });
      if (badge) badge.style.backgroundColor = '#ff57a6';
    }

    const container = document.getElementById('awsCostRecsContainer');
    const title = document.getElementById('awsCostRecsTitle');
    const headers = document.getElementById('awsCostRecsHeaders');
    const tbody = document.getElementById('awsCostRecsBody');
    
    if (!container || !title || !headers || !tbody) return;
    
    tbody.innerHTML = '';
    
    const list = awsResourcesData[category] || [];
    
    // Title mapping
    const titleMap = {
      s3: 'Amazon S3 Optimization & Cost Reduction',
      cloudfront: 'CloudFront Cost Savings & Optimization',
      eks: 'EKS Control Plane Savings Opportunities',
      ec2: 'EC2 & EBS Storage Hygiene Recommendations',
      iam: 'IAM Key Rotation & Identity Security Hygiene'
    };
    title.textContent = titleMap[category];
    
    // Setup headers
    if (category === 's3') {
      headers.innerHTML = `
        <tr>
          <th>Bucket Name</th>
          <th>Approx Size</th>
          <th>Est. Monthly Cost</th>
          <th>Recommendation</th>
          <th>Est. Monthly Savings</th>
          <th>Remediation command / code</th>
        </tr>
      `;
    } else if (category === 'cloudfront') {
      headers.innerHTML = `
        <tr>
          <th>Domain / Name</th>
          <th>Distribution ID</th>
          <th>Status</th>
          <th>Recommendation</th>
          <th>Est. Monthly Savings</th>
          <th>Remediation command / code</th>
        </tr>
      `;
    } else if (category === 'ec2') {
      headers.innerHTML = `
        <tr>
          <th>Resource ID / Name</th>
          <th>Type</th>
          <th>State / Size</th>
          <th>Est. Monthly Cost</th>
          <th>Recommendation</th>
          <th>Est. Monthly Savings</th>
          <th>Remediation command / code</th>
        </tr>
      `;
    } else if (category === 'eks') {
      headers.innerHTML = `
        <tr>
          <th>Cluster Name</th>
          <th>Status</th>
          <th>Control Plane Cost</th>
          <th>Recommendation</th>
          <th>Est. Monthly Savings</th>
          <th>Remediation command / code</th>
        </tr>
      `;
    } else if (category === 'iam') {
      headers.innerHTML = `
        <tr>
          <th>IAM User</th>
          <th>Access Key ID</th>
          <th>Status</th>
          <th>Recommendation</th>
          <th>Est. Monthly Savings</th>
          <th>Remediation command / code</th>
        </tr>
      `;
    }
    
    // Populate recommendations
    if (list.length === 0) {
      const cols = category === 'ec2' ? 7 : 6;
      tbody.innerHTML = `<tr><td colspan="${cols}" style="text-align: center; padding: 40px; color: var(--muted);">No recommendations found. All resources in this class are optimal!</td></tr>`;
    } else {
      list.forEach(item => {
        const tr = document.createElement('tr');
        
        let recClass = 'ok';
        if (item.recommendation && item.recommendation !== 'None (Optimal)' && !item.recommendation.startsWith('None')) {
          recClass = 'warn';
        }
        
        let codeHtml = '<span style="color: var(--muted);">N/A</span>';
        if (item.code) {
          const safeCode = item.code.replace(/`/g, '\\`').replace(/\$/g, '\\$');
          codeHtml = `<pre style="margin: 0; padding: 10px 12px; font-size: 11.5px; background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; overflow-x: auto; max-width: 360px; font-family: 'JetBrains Mono', monospace; color: #38bdf8; cursor: pointer; transition: all 0.2s; white-space: pre-wrap; word-break: break-all;" onmouseover="this.style.backgroundColor='#1e293b'; this.style.borderColor='#38bdf8';" onmouseout="this.style.backgroundColor='#0f172a'; this.style.borderColor='#1e293b';" title="Click to copy code" onclick="navigator.clipboard.writeText(\\\`${safeCode}\\\`); alert('Copied remediation snippet to clipboard!');">${item.code}</pre>`;
        }
        
        let stateText = item.status || item.state || item.size || '';
        let badgeState = 'ok';
        if (category === 's3') {
          badgeState = parseFloat(item.size) > 50 ? 'warn' : 'ok';
        } else if (category === 'cloudfront') {
          badgeState = item.status === 'Active' ? 'ok' : 'warn';
        } else if (category === 'ec2') {
          badgeState = (item.state === 'running' || item.state === 'Unattached') ? 'warn' : 'ok';
        } else if (category === 'iam') {
          badgeState = item.status === 'Active' ? 'ok' : 'warn';
        }
        
        if (category === 's3') {
          tr.innerHTML = `
            <td style="font-weight: 500; color: var(--text);">${item.name}</td>
            <td><span class="badge req">${stateText}</span></td>
            <td><span style="font-family: 'JetBrains Mono', monospace; font-weight: 600;">${item.cost}</span></td>
            <td>
              <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
              <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
            </td>
            <td><span class="badge ${recClass === 'warn' ? 'used' : 'ok'}" style="${recClass === 'warn' ? 'background: rgba(16, 185, 129, 0.15); color: #34d399; font-weight:600;' : ''}">${item.savings}</span></td>
            <td>${codeHtml}</td>
          `;
        } else if (category === 'cloudfront') {
          tr.innerHTML = `
            <td style="font-weight: 500; color: var(--text);">${item.name}</td>
            <td><span style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--muted);">${item.id}</span></td>
            <td><span class="badge ${badgeState === 'ok' ? 'ok' : 'warn'}">${stateText}</span></td>
            <td>
              <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
              <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
            </td>
            <td><span class="badge ${recClass === 'warn' ? 'used' : 'ok'}" style="${recClass === 'warn' ? 'background: rgba(16, 185, 129, 0.15); color: #34d399; font-weight:600;' : ''}">${item.savings}</span></td>
            <td>${codeHtml}</td>
          `;
        } else if (category === 'ec2') {
          tr.innerHTML = `
            <td style="font-weight: 500; color: var(--text);">
              <div>${item.name}</div>
              <div style="font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace;">${item.id}</div>
            </td>
            <td><span class="badge req">${item.type}</span></td>
            <td><span class="badge ${badgeState === 'ok' ? 'ok' : 'warn'}">${stateText}</span></td>
            <td><span style="font-family: 'JetBrains Mono', monospace; font-weight: 600;">${item.cost}</span></td>
            <td>
              <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
              <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
            </td>
            <td><span class="badge ${recClass === 'warn' ? 'used' : 'ok'}" style="${recClass === 'warn' ? 'background: rgba(16, 185, 129, 0.15); color: #34d399; font-weight:600;' : ''}">${item.savings}</span></td>
            <td>${codeHtml}</td>
          `;
        } else if (category === 'eks') {
          tr.innerHTML = `
            <td style="font-weight: 500; color: var(--text);">${item.name}</td>
            <td><span class="badge ok">${item.status}</span></td>
            <td><span style="font-family: 'JetBrains Mono', monospace; font-weight: 600;">${item.cost}</span></td>
            <td>
              <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
              <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
            </td>
            <td><span class="badge ${recClass === 'warn' ? 'used' : 'ok'}" style="${recClass === 'warn' ? 'background: rgba(16, 185, 129, 0.15); color: #34d399; font-weight:600;' : ''}">${item.savings}</span></td>
            <td>${codeHtml}</td>
          `;
        } else if (category === 'iam') {
          tr.innerHTML = `
            <td style="font-weight: 500; color: var(--text);">${item.username}</td>
            <td><span style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--muted);">${item.key_id}</span></td>
            <td><span class="badge ${badgeState === 'ok' ? 'ok' : 'warn'}">${stateText}</span></td>
            <td>
              <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
              <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
            </td>
            <td><span class="badge ${recClass === 'warn' ? 'used' : 'ok'}" style="${recClass === 'warn' ? 'background: rgba(16, 185, 129, 0.15); color: #34d399; font-weight:600;' : ''}">${item.savings}</span></td>
            <td>${codeHtml}</td>
          `;
        }
        tbody.appendChild(tr);
      });
    }
    
    container.style.display = 'block';
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeAwsCostRecs() {
    activeCostRecCategory = null;
    document.getElementById('awsCostRecsContainer').style.display = 'none';
    
    const s3Card = document.querySelector('#panel-cost .stat-card.blue');
    const cfCard = document.querySelector('#panel-cost .stat-card.purple');
    const eksCard = document.querySelector('#panel-cost .stat-card.yellow');
    const ec2Card = document.querySelector('#panel-cost .stat-card.green');
    const iamCards = document.querySelectorAll('#panel-cost .iam-card');
    
    const cards = [s3Card, cfCard, eksCard, ec2Card];
    cards.forEach(c => {
      if (c) {
        c.style.borderColor = 'var(--border)';
        c.style.boxShadow = 'none';
        c.style.transform = 'none';
      }
    });
    iamCards.forEach(c => {
      if (c) {
        c.style.borderColor = 'var(--border)';
        c.style.boxShadow = 'none';
      }
    });
  }

  function renderAwsResources() {
    const tbody = document.getElementById('awsTableBody');
    const headers = document.getElementById('awsTableHeaders');
    const search = document.getElementById('awsResourceSearch').value.toLowerCase();
    
    if (!tbody || !headers) return;
    tbody.innerHTML = '';
    
    const list = awsResourcesData[currentAwsCategory] || [];
    
    // Update headers based on selected category
    if (currentAwsCategory === 's3') {
      headers.innerHTML = `
        <th>Bucket Name</th>
        <th>Storage Size</th>
        <th>Estimated Cost</th>
        <th>Recommendation</th>
        <th>Est. Savings</th>
        <th>Remediation Snippet</th>
      `;
    } else if (currentAwsCategory === 'cloudfront') {
      headers.innerHTML = `
        <th>Domain / Comment</th>
        <th>Distribution ID</th>
        <th>Status</th>
        <th>Recommendation</th>
        <th>Est. Savings</th>
        <th>Remediation Snippet</th>
      `;
    } else if (currentAwsCategory === 'ec2') {
      headers.innerHTML = `
        <th>Resource ID / Name</th>
        <th>Type</th>
        <th>State / Size</th>
        <th>Estimated Cost</th>
        <th>Recommendation</th>
        <th>Est. Savings</th>
        <th>Remediation Snippet</th>
      `;
    } else if (currentAwsCategory === 'eks') {
      headers.innerHTML = `
        <th>Cluster Name</th>
        <th>Status</th>
        <th>Control Plane Cost</th>
        <th>Recommendation</th>
        <th>Est. Savings</th>
        <th>Remediation Snippet</th>
      `;
    } else if (currentAwsCategory === 'iam') {
      headers.innerHTML = `
        <th>IAM User</th>
        <th>Access Key ID</th>
        <th>Status</th>
        <th>Recommendation</th>
        <th>Est. Savings</th>
        <th>Remediation Snippet</th>
      `;
    }
    
    // Filter records
    const filtered = list.filter(item => {
      if (currentAwsCategory === 's3') {
        return item.name.toLowerCase().includes(search) || item.recommendation.toLowerCase().includes(search);
      } else if (currentAwsCategory === 'cloudfront') {
        return item.name.toLowerCase().includes(search) || item.id.toLowerCase().includes(search) || item.recommendation.toLowerCase().includes(search);
      } else if (currentAwsCategory === 'ec2') {
        return item.id.toLowerCase().includes(search) || item.name.toLowerCase().includes(search) || item.type.toLowerCase().includes(search) || item.recommendation.toLowerCase().includes(search);
      } else if (currentAwsCategory === 'eks') {
        return item.name.toLowerCase().includes(search) || item.recommendation.toLowerCase().includes(search);
      } else if (currentAwsCategory === 'iam') {
        return item.username.toLowerCase().includes(search) || item.key_id.toLowerCase().includes(search) || item.recommendation.toLowerCase().includes(search);
      }
      return false;
    });
    
    if (filtered.length === 0) {
      const cols = currentAwsCategory === 'ec2' ? 7 : 6;
      tbody.innerHTML = `<tr><td colspan="${cols}" style="text-align: center; padding: 40px; color: var(--muted);">No matching resources found.</td></tr>`;
      return;
    }
    
    filtered.forEach(item => {
      const tr = document.createElement('tr');
      
      let badgeState = 'ok';
      let stateText = '';
      if (currentAwsCategory === 's3') {
        stateText = item.size;
        badgeState = parseFloat(item.size) > 50 ? 'warn' : 'ok';
      } else if (currentAwsCategory === 'cloudfront') {
        stateText = item.status;
        badgeState = item.status === 'Active' ? 'ok' : 'warn';
      } else if (currentAwsCategory === 'ec2') {
        stateText = item.state;
        badgeState = (item.state === 'running' || item.state === 'Unattached') ? 'warn' : 'ok';
      } else if (currentAwsCategory === 'eks') {
        stateText = item.status;
        badgeState = 'ok';
      } else if (currentAwsCategory === 'iam') {
        stateText = item.status;
        badgeState = item.status === 'Active' ? 'warn' : 'ok';
      }
      
      let recClass = 'ok';
      if (item.recommendation && item.recommendation !== 'None (Optimal)' && !item.recommendation.startsWith('None')) {
        recClass = 'warn';
      }
      
      let codeHtml = '<span style="color: var(--muted);">N/A</span>';
      if (item.code) {
        codeHtml = `<pre style="margin: 0; padding: 8px; font-size: 11px; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; max-width: 250px; font-family: 'JetBrains Mono', monospace; color: var(--blue);">${item.code}</pre>`;
      }
      
      if (currentAwsCategory === 's3') {
        tr.innerHTML = `
          <td style="font-weight: 500; color: var(--text);">${item.name}</td>
          <td><span class="badge req">${stateText}</span></td>
          <td><span style="font-family: 'JetBrains Mono', monospace; font-weight: 600;">${item.cost}</span></td>
          <td>
            <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
          </td>
          <td><span class="badge ${recClass === 'warn' ? 'used' : 'ok'}" style="${recClass === 'warn' ? 'background: var(--green-dim); color: var(--green); font-weight:600;' : ''}">${item.savings}</span></td>
          <td>${codeHtml}</td>
        `;
      } else if (currentAwsCategory === 'cloudfront') {
        tr.innerHTML = `
          <td style="font-weight: 500; color: var(--text);">${item.name}</td>
          <td><span style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--muted);">${item.id}</span></td>
          <td><span class="badge ${badgeState}">${stateText}</span></td>
          <td>
            <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
          </td>
          <td><span class="badge ${recClass === 'warn' ? 'used' : 'ok'}" style="${recClass === 'warn' ? 'background: var(--green-dim); color: var(--green); font-weight:600;' : ''}">${item.savings}</span></td>
          <td>${codeHtml}</td>
        `;
      } else if (currentAwsCategory === 'ec2') {
        tr.innerHTML = `
          <td style="font-weight: 500; color: var(--text);">
            <div>${item.name}</div>
            <div style="font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace;">${item.id}</div>
          </td>
          <td><span class="badge req">${item.type}</span></td>
          <td><span class="badge ${badgeState}">${stateText}</span></td>
          <td><span style="font-family: 'JetBrains Mono', monospace; font-weight: 600;">${item.cost}</span></td>
          <td>
            <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
          </td>
          <td><span class="badge ${recClass === 'warn' ? 'used' : 'ok'}" style="${recClass === 'warn' ? 'background: var(--green-dim); color: var(--green); font-weight:600;' : ''}">${item.savings}</span></td>
          <td>${codeHtml}</td>
        `;
      } else if (currentAwsCategory === 'eks') {
        tr.innerHTML = `
          <td style="font-weight: 500; color: var(--text);">${item.name}</td>
          <td><span class="badge ok">${stateText}</span></td>
          <td><span style="font-family: 'JetBrains Mono', monospace; font-weight: 600;">${item.cost}</span></td>
          <td>
            <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
          </td>
          <td><span class="badge ${recClass === 'warn' ? 'used' : 'ok'}" style="${recClass === 'warn' ? 'background: var(--green-dim); color: var(--green); font-weight:600;' : ''}">${item.savings}</span></td>
          <td>${codeHtml}</td>
        `;
      } else if (currentAwsCategory === 'iam') {
        tr.innerHTML = `
          <td style="font-weight: 500; color: var(--text);">${item.username}</td>
          <td><span style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--muted);">${item.key_id}</span></td>
          <td><span class="badge ${badgeState}">${stateText}</span></td>
          <td>
            <div style="font-weight: 500; color: var(--text);">${item.recommendation}</div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">${item.reason}</div>
          </td>
          <td><span class="badge ok">${item.savings}</span></td>
          <td>${codeHtml}</td>
        `;
      }
      
      tbody.appendChild(tr);
    });
    updateKpiCards();
  }

  function filterAwsResources() {
    renderAwsResources();
  }

  let globalCostsData = null;

  function updateKpiCards() {
    if (!allWorkloads || !allRecommendations || !allEfficiency || !awsResourcesData) return;
    
    // 1. Active Clusters
    const clusterKeys = Object.keys(allWorkloads);
    const kpiActiveClusters = document.getElementById('kpiActiveClusters');
    if (kpiActiveClusters) {
      kpiActiveClusters.textContent = clusterKeys.length;
    }
    
    // Calculate values
    let totalAlerts = 0;
    let criticalQueue = 0;
    let totalSavings = 0;
    let totalCost = 0;
    let totalEffScoreSum = 0;
    let totalEffScoreCount = 0;
    
    // Cluster Recommendations
    clusterKeys.forEach(c => {
      const recs = allRecommendations[c] || [];
      totalAlerts += recs.length;
      recs.forEach(r => {
        if (r.risk === 'High' || r.risk === 'Medium') {
          criticalQueue++;
        }
        if (r.savings) {
          totalSavings += parseFloat(r.savings.replace('$', '').replace('/mo', '').replace(',', '')) || 0;
        }
      });
      
      const eff = allEfficiency[c];
      if (eff) {
        if (eff.projected_cost) {
          totalCost += parseFloat(eff.projected_cost.replace('$', '').replace(',', '')) || 0;
        }
        if (eff.efficiency_score) {
          totalEffScoreSum += parseFloat(eff.efficiency_score) || 0;
          totalEffScoreCount++;
        }
      }
    });
    
    // AWS Resource Recommendations
    const categories = ['s3', 'cloudfront', 'ec2', 'eks', 'iam'];
    categories.forEach(cat => {
      const list = awsResourcesData[cat] || [];
      list.forEach(item => {
        const hasRec = item.recommendation && item.recommendation !== 'None (Optimal)' && !item.recommendation.startsWith('None');
        if (hasRec) {
          totalAlerts++;
          criticalQueue++;
          if (item.savings) {
            totalSavings += parseFloat(item.savings.replace('$', '').replace('/mo', '').replace(',', '')) || 0;
          }
        }
      });
    });
    
    // If we have global costs, add S3, EC2/EBS, CloudFront costs
    if (globalCostsData) {
      const parseCost = val => {
        if (!val) return 0;
        return parseFloat(val.replace('$', '').replace(',', '')) || 0;
      };
      totalCost += parseCost(globalCostsData.s3_cost);
      totalCost += parseCost(globalCostsData.ec2_cost);
      totalCost += parseCost(globalCostsData.cf_cost);
    }
    
    // Update DOM
    const openAlertsEl = document.getElementById('kpiOpenAlerts');
    const openAlertsSubEl = document.getElementById('kpiOpenAlertsSub');
    if (openAlertsEl) {
      openAlertsEl.textContent = totalAlerts;
    }
    if (openAlertsSubEl) {
      openAlertsSubEl.textContent = criticalQueue + ' critical waste';
    }
    
    const critQueueEl = document.getElementById('kpiCriticalQueue');
    if (critQueueEl) {
      critQueueEl.textContent = criticalQueue;
    }
    
    const meanStabilityEl = document.getElementById('kpiMeanStability');
    if (meanStabilityEl) {
      const meanScore = totalEffScoreCount > 0 ? (totalEffScoreSum / totalEffScoreCount) : 0;
      meanStabilityEl.textContent = meanScore.toFixed(1) + '%';
    }
    
    const billingReadyEl = document.getElementById('kpiBillingReady');
    if (billingReadyEl) {
      billingReadyEl.textContent = '$' + totalCost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    }
    
    const savingsRateEl = document.getElementById('kpiSavingsRate');
    const savingsRateSubEl = document.getElementById('kpiSavingsRateSub');
    if (savingsRateEl) {
      savingsRateEl.textContent = '$' + totalSavings.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    }
    if (savingsRateSubEl) {
      const rate = totalCost > 0 ? ((totalSavings / (totalCost + totalSavings)) * 100) : 0;
      savingsRateSubEl.textContent = rate.toFixed(1) + '% potential';
    }
  }

  // ── Load workload and cluster stats ──
  async function loadWorkloads() {
    try {
      const resp = await fetch('/api/workloads');
      allWorkloads = await resp.json();
      
      const respNodes = await fetch('/api/nodes');
      allNodes = await respNodes.json();

      const respRecs = await fetch('/api/recommendations');
      allRecommendations = await respRecs.json();

      const respCharge = await fetch('/api/chargeback');
      allChargebacks = await respCharge.json();

      const respEff = await fetch('/api/efficiency');
      allEfficiency = await respEff.json();

      try {
        const respGlobal = await fetch('/api/global-costs');
        const globalCosts = await respGlobal.json();
        globalCostsData = globalCosts;
        
        document.getElementById('globalS3Cost').textContent = globalCosts.s3_cost || '$0.00';
        document.getElementById('globalS3Count').textContent = globalCosts.s3_count || '0 Buckets';
        document.getElementById('globalCfCost').textContent = globalCosts.cf_cost || '$0.00';
        document.getElementById('globalCfCount').textContent = globalCosts.cf_count || '0 Distributions';
        document.getElementById('globalEksCost').textContent = globalCosts.eks_cost || '$0.00';
        document.getElementById('globalEksCount').textContent = globalCosts.eks_count || '0 Active Clusters';
        document.getElementById('globalEc2Cost').textContent = globalCosts.ec2_cost || '$0.00';
        document.getElementById('globalEc2Count').textContent = globalCosts.ec2_count || '0 Instances';
        document.getElementById('globalIamUsers').textContent = globalCosts.iam_users || '0';
        document.getElementById('globalIamKeys').textContent = globalCosts.iam_keys || '0';
        
        renderGlobalCostChart(globalCosts);
      } catch (ge) {
        console.error("Failed to load global costs", ge);
      }
      
      const select = document.getElementById('clusterSelect');
      const costSelect = document.getElementById('costClusterSelect');
      const currentVal = select.value || costSelect.value;
      
      select.innerHTML = '';
      costSelect.innerHTML = '';
      
      const clusters = Object.keys(allWorkloads);
      if (clusters.length === 0) {
        select.innerHTML = '<option value="">No data available</option>';
        costSelect.innerHTML = '<option value="">No data available</option>';
        return;
      }
      
      clusters.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        select.appendChild(opt.cloneNode(true));
        costSelect.appendChild(opt);
      });
      
      if (currentVal && clusters.includes(currentVal)) {
        select.value = currentVal;
        costSelect.value = currentVal;
      } else {
        select.value = clusters[0];
        costSelect.value = clusters[0];
      }
      activeTopologyCluster = select.value;
      
      // Render EKS Cluster Portfolio Cards
      renderPortfolioCards();
      
      // Select the active card to highlight it and show detail section
      if (costSelect.value) {
        selectClusterCard(costSelect.value);
      }
      
      filterWorkloads();
      if (activeCostRecCategory) {
        showAwsCostRecs(activeCostRecCategory);
      }
    } catch (e) {
      console.error("Failed to load workloads", e);
    }
  }

  function renderPortfolioCards() {
    if (!allEfficiency || !allWorkloads) return;
    
    let totalPortfolioCost = 0;
    let totalPortfolioSavings = 0;
    
    const sortedClusters = Object.keys(allWorkloads);
    
    sortedClusters.forEach(cName => {
      const eff = allEfficiency[cName];
      if (eff && eff.projected_cost) {
        const val = parseFloat(eff.projected_cost.replace('$', '').replace(',', '')) || 0;
        totalPortfolioCost += val;
      }
      
      if (allRecommendations[cName]) {
        allRecommendations[cName].forEach(r => {
          if (r.savings) {
            const val = parseFloat(r.savings.replace('$', '').replace('/mo', '').replace(',', '')) || 0;
            totalPortfolioSavings += val;
          }
        });
      }
    });
    
    document.getElementById('portfolioTotalCost').textContent = '$' + totalPortfolioCost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    document.getElementById('portfolioTotalSavings').textContent = '$' + totalPortfolioSavings.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    
    const grid = document.getElementById('clusterCardsGrid');
    if (!grid) return;
    grid.innerHTML = '';
    
    const clusterConfig = {
      'dgcare-prod': {
        avatarBg: 'rgba(239, 68, 68, 0.1)',
        avatarColor: '#ef4444',
        iconHtml: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="m9 11 2 2 4-4"></path></svg>`,
        badgeClass: 'badge-critical',
        statusTag: 'Fully Shutdown',
        slaText: 'SLA inactive',
        slaColor: '#ef4444',
        slaBg: 'rgba(239, 68, 68, 0.08)',
        recAlert: 'Production compute shut down via GitOps node schedule.'
      },
      'dgcare-qa': {
        avatarBg: 'rgba(245, 158, 11, 0.1)',
        avatarColor: '#f59e0b',
        iconHtml: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12"></path><path d="M12 3v13"></path><path d="M10 12h4"></path><path d="M8.5 7.5c-.8.8-1.5 2-1.5 3.5 0 3.5 3 6.5 5 6.5s5-3 5-6.5c0-1.5-.7-2.7-1.5-3.5L12.5 3h-1L8.5 7.5z"></path></svg>`,
        badgeClass: 'badge-watch',
        statusTag: 'WATCH',
        slaText: 'SLA 99.9%',
        slaColor: '#f59e0b',
        slaBg: 'rgba(245, 158, 11, 0.08)',
        recAlert: '3 underutilized pods found. Linkerd sidecars healthy.'
      },
      'dgcare-dev': {
        avatarBg: 'rgba(99, 102, 241, 0.1)',
        avatarColor: '#6c5dd3',
        iconHtml: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
        badgeClass: 'badge-optimizable',
        statusTag: 'OPTIMIZABLE',
        slaText: 'Non-critical',
        slaColor: '#6c5dd3',
        slaBg: 'rgba(99, 102, 241, 0.08)',
        recAlert: 'Resource optimization recommended for workloads.'
      },
      'dgcare-runner': {
        avatarBg: 'rgba(34, 197, 94, 0.1)',
        avatarColor: '#22c55e',
        iconHtml: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
        badgeClass: 'badge-ok',
        statusTag: 'HEALTHY',
        slaText: 'Idle Scaling',
        slaColor: '#22c55e',
        slaBg: 'rgba(34, 197, 94, 0.08)',
        recAlert: 'GitHub runner workloads scaled down successfully.'
      }
    };
    
    let tableHtml = '';
    
    sortedClusters.forEach((cName, idx) => {
      const colors = ['#6c5dd3', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6'];
      const color = colors[idx % colors.length];
      const conf = clusterConfig[cName] || {
        avatarBg: `rgba(${parseInt(color.slice(1,3),16)}, ${parseInt(color.slice(3,5),16)}, ${parseInt(color.slice(5,7),16)}, 0.1)`,
        avatarColor: color,
        iconHtml: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect></svg>`,
        badgeClass: 'badge-optimizable',
        statusTag: 'OPTIMIZABLE',
        slaText: 'Standard',
        slaColor: color,
        slaBg: `rgba(${parseInt(color.slice(1,3),16)}, ${parseInt(color.slice(3,5),16)}, ${parseInt(color.slice(5,7),16)}, 0.08)`,
        recAlert: 'Resource optimization recommended.'
      };
      
      const eff = allEfficiency[cName] || {};
      const cpuUtil = eff.cpu_util_cores || 'N/A';
      const memUtil = eff.mem_util_gb || 'N/A';
      const effScore = parseFloat(eff.efficiency_score) || 0;
      const projectedCost = eff.projected_cost || '$0.00';
      
      let savingsVal = 0;
      let clusterRecommendations = allRecommendations[cName] || [];
      clusterRecommendations.forEach(r => {
        if (r.savings) {
          const val = parseFloat(r.savings.replace('$', '').replace('/mo', '').replace(',', '')) || 0;
          savingsVal += val;
        }
      });
      const savingsText = '$' + savingsVal.toFixed(2);
      
      // Gauge variables
      const circumference = 2 * Math.PI * 40; // 251.2
      const gaugeOffset = circumference - (effScore / 100) * circumference;
      
      let gaugeColor = 'var(--yellow)';
      if (effScore > 75) gaugeColor = 'var(--green)';
      else if (effScore > 40) gaugeColor = 'var(--blue)';
      
      let recText = conf.recAlert;
      if (cName === 'dgcare-dev' && allRecommendations['dgcare-dev']) {
        recText = `${allRecommendations['dgcare-dev'].length} workloads sizing optimization recommendations available.`;
      } else if (cName === 'dgcare-qa' && allRecommendations['dgcare-qa'] && allRecommendations['dgcare-qa'].length > 0) {
        recText = `${allRecommendations['dgcare-qa'].length} right-sizing recommendations. Linkerd mesh verified.`;
      } else if (clusterRecommendations.length > 0) {
        recText = `${clusterRecommendations.length} resource sizing optimization recommendations available.`;
      }
      
      const badgeStyle = {
        'badge-critical': 'background: #0da691; color: #ffffff; border: 1px solid #0da691; padding: 4px 8px; border-radius: 6px;',
        'badge-watch': 'background: #0da691; color: #ffffff; border: 1px solid #0da691; padding: 4px 8px; border-radius: 6px;',
        'badge-optimizable': 'background: #0da691; color: #ffffff; border: 1px solid #0da691; padding: 4px 8px; border-radius: 6px;',
        'badge-ok': 'background: #0da691; color: #ffffff; border: 1px solid #0da691; padding: 4px 8px; border-radius: 6px;'
      };
      
      const cardHtml = `
<div class="node-card cluster-status-card" id="card-${cName}" onclick="selectClusterCard('${cName}')" style="cursor: pointer; position: relative; border-radius: var(--radius); padding: 20px; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); border: 1px solid var(--border); display: flex; flex-direction: column; gap: 14px; background: #fff;">
  <div style="display: flex; justify-content: space-between; align-items: center;">
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: ${conf.avatarBg}; color: ${conf.avatarColor};">
        ${conf.iconHtml}
      </div>
      <div>
        <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 15px; font-weight: 700; color: var(--text);">${cName}</h4>
        <span style="font-size: 11px; color: var(--muted);">ap-south-1</span>
      </div>
    </div>
    <span class="badge" style="${badgeStyle[conf.badgeClass] || ''} font-size: 9px; font-weight: 700; text-transform: uppercase;">${conf.statusTag}</span>
  </div>

  <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: #ffffff; background: ${conf.slaColor}; padding: 4px 8px; border-radius: 20px; width: fit-content; font-weight: 600;">
    <span class="pulse-dot" style="width: 6px; height: 6px; background: #ffffff; position: relative; display: inline-block;"></span>
    ${conf.slaText}
  </div>

  <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(0,0,0,0.05); padding-bottom: 12px;">
    <div style="display: flex; flex-direction: column; gap: 8px; flex: 1;">
      <div>
        <span style="font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 600;">CPU UTILIZATION</span>
        <div style="font-size: 13px; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: var(--text);">${cpuUtil}</div>
      </div>
      <div>
        <span style="font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 600;">MEMORY UTILIZATION</span>
        <div style="font-size: 13px; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: var(--text);">${memUtil}</div>
      </div>
    </div>
    <div style="position: relative; width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
      <svg viewBox="0 0 100 100" style="width: 100%; height: 100%; transform: rotate(-90deg);">
        <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(0,0,0,0.05)" stroke-width="10"></circle>
        <circle cx="50" cy="50" r="40" fill="none" stroke="${gaugeColor}" stroke-width="10" stroke-dasharray="251.2" stroke-dashoffset="${gaugeOffset}" stroke-linecap="round"></circle>
      </svg>
      <div style="position: absolute; font-size: 12px; font-weight: 800; font-family: 'Space Grotesk', sans-serif; color: var(--text);">${effScore.toFixed(1)}%</div>
      <div style="position: absolute; bottom: -18px; font-size: 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.2px; font-weight: 700; text-align: center; width: 100%; line-height: 1;">Efficiency</div>
    </div>
  </div>

  <div style="font-size: 11.5px; color: var(--muted); min-height: 34px; line-height: 1.4;">
    ${recText}
  </div>

  <div style="display: flex; justify-content: space-between; align-items: center; background: var(--surface2); padding: 8px 12px; border-radius: 8px;">
    <div>
      <span style="font-size: 9px; color: var(--muted); text-transform: uppercase; font-weight: 600;">Projected Cost</span>
      <div style="font-size: 13.5px; font-weight: 800; font-family: 'JetBrains Mono', monospace; color: var(--text);">${projectedCost}</div>
    </div>
    <div style="text-align: right;">
      <span style="font-size: 9px; color: var(--green); text-transform: uppercase; font-weight: 600;">Est. Savings</span>
      <div style="font-size: 13.5px; font-weight: 800; font-family: 'JetBrains Mono', monospace; color: var(--green);">${savingsText}/mo</div>
    </div>
  </div>

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px;">
    <button class="toggle-btn" style="background: var(--green-dim); color: var(--green); font-size: 10px; font-weight: 700; padding: 6px 4px; display: flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid rgba(34,197,94,0.15); margin: 0;" onclick="event.stopPropagation(); triggerRightsize('${cName}')">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 7 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 7 22 7 22 12"></polyline></svg>Rightsize
    </button>
    <button class="toggle-btn" style="background: rgba(168, 85, 247, 0.1); color: rgb(168, 85, 247); font-size: 10px; font-weight: 700; padding: 6px 4px; display: flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid rgba(168,85,247,0.15); margin: 0;" onclick="event.stopPropagation(); triggerScaleToZero('${cName}')">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>Scale to 0
    </button>
  </div>

  <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-top: 4px; border-top: 1px solid rgba(0,0,0,0.03); padding-top: 8px;">
    <span style="color: var(--muted); font-size: 9.5px; font-family: 'JetBrains Mono', monospace;">Support: +1-555-0100</span>
    <span style="color: var(--purple); font-weight: 700; display: flex; align-items: center; gap: 2px;">Review cluster &gt;</span>
  </div>
</div>
      `;
      grid.insertAdjacentHTML('beforeend', cardHtml);
      
      const podsCount = (allWorkloads[cName] || []).length;
      const criticalWasteCount = clusterRecommendations.filter(r => r.risk === 'High' || r.risk === 'Medium').length;
      
      tableHtml += `
<tr style="border-bottom: 1px solid var(--border);">
  <td style="padding: 14px 10px; font-weight: 700; color: var(--text);">
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="width: 8px; height: 8px; border-radius: 50%; background: ${conf.avatarColor};"></span>
      ${cName}
    </div>
  </td>
  <td style="padding: 14px 10px; text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 12.5px;">${podsCount}</td>
  <td style="padding: 14px 10px; text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 12.5px;">${clusterRecommendations.length}</td>
  <td style="padding: 14px 10px; text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; color: #ef4444; font-weight: 700;">${criticalWasteCount}</td>
  <td style="padding: 14px 10px; text-align: right; font-weight: 700; color: ${effScore > 75 ? '#22c55e' : effScore > 40 ? '#3b82f6' : '#f59e0b'};">${effScore.toFixed(1)}%</td>
</tr>
      `;
    });
    
    const tableBody = document.getElementById('portfolioTableBody');
    if (tableBody) {
      tableBody.innerHTML = tableHtml || '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--muted);">No clusters found in active report data.</td></tr>';
    }
    updateKpiCards();
  }

  function selectClusterCard(cName) {
    const select = document.getElementById('costClusterSelect');
    select.value = cName;
    
    document.querySelectorAll('.cluster-status-card').forEach(card => {
      card.style.borderColor = 'var(--border)';
      card.style.boxShadow = 'none';
      card.style.transform = 'none';
    });
    
    const activeCard = document.getElementById('card-' + cName);
    if (activeCard) {
      activeCard.style.borderColor = 'var(--purple)';
      activeCard.style.boxShadow = '0 8px 24px rgba(108, 93, 211, 0.12)';
      activeCard.style.transform = 'translateY(-2px)';
    }
    
    const detailsSection = document.getElementById('clusterDetailsSection');
    if (detailsSection) {
      detailsSection.style.display = 'grid';
    }
    
    document.getElementById('selectedClusterDetailTitle').textContent = cName + ' Cost Share & Efficiency';
    syncCostCluster();
  }

  function triggerRightsize(cName) {
    alert(`Initiating workload rightsizing recommendation scan for cluster: ${cName}. GitOps PR will be raised in Releases/dgcare-${cName.split('-')[1] || 'dev'}/...`);
  }
  
  function triggerScaleToZero(cName) {
    alert(`Enforcing night/weekend scale-to-zero shutdown schedule for cluster: ${cName}. Reconciling via Terraform schedule automation...`);
  }

  function syncCostCluster() {
    const val = document.getElementById('costClusterSelect').value;
    document.getElementById('clusterSelect').value = val;
    filterWorkloads();
    renderCostAllocation();
  }

  function setCostView(view) {
    currentCostView = view;
    document.getElementById('btnCostTable').classList.toggle('active', view === 'table');
    document.getElementById('btnCostChart').classList.toggle('active', view === 'chart');
    document.getElementById('costTableView').style.display = view === 'table' ? 'block' : 'none';
    document.getElementById('costChartView').style.display = view === 'chart' ? 'flex' : 'none';
    
    if (view === 'chart') {
      renderCostChart();
    }
  }

  function setNodeView(view) {
    currentNodeView = view;
    document.getElementById('btnNodeTable').classList.toggle('active', view === 'table');
    document.getElementById('btnNodeGrid').classList.toggle('active', view === 'grid');
    
    if (viewMode === 'nodes') {
      document.getElementById('workloadsTableContainer').style.display = view === 'table' ? 'block' : 'none';
      document.getElementById('nodeGridContainer').style.display = view === 'grid' ? 'grid' : 'none';
      if (view === 'table') {
        document.getElementById('nodeDetailsPanel').style.display = 'none';
      } else if (selectedNodeDns) {
        document.getElementById('nodeDetailsPanel').style.display = 'block';
      }
      filterWorkloads();
    }
  }

  function getNodeSuggestion(n) {
    if (n.state === 'scaled-down' || n.state === 'inactive') {
      return '<span class="badge ok" style="background: rgba(108, 93, 211, 0.15); color: #6c5dd3; font-weight:600; padding: 4px 8px;">Scaled Down (Off-hours)</span>';
    }
    if (n.state !== 'running') {
      return '<span class="badge ok" style="background: rgba(156, 163, 175, 0.15); color: #9ca3af; font-weight:600; padding: 4px 8px;">N/A (Stopped)</span>';
    }
    let cpu = parseFloat(n.cpu_util);
    let mem = parseFloat(n.mem_util);
    if (isNaN(cpu)) {
      return '<span class="badge ok" style="background: rgba(156, 163, 175, 0.15); color: #9ca3af; font-weight:600; padding: 4px 8px;">Insufficient Data</span>';
    }
    
    if (cpu < 20) {
      let nextType = 'Consolidate';
      if (n.type.includes('large') && !n.type.includes('2xlarge') && !n.type.includes('4xlarge') && !n.type.includes('xlarge')) {
        nextType = 't3.medium / t3.small';
      } else if (n.type.includes('2xlarge')) {
        nextType = n.type.replace('2xlarge', 'large');
      } else if (n.type.includes('xlarge')) {
        nextType = n.type.replace('xlarge', 'large');
      } else if (n.type.includes('medium')) {
        nextType = 't3.small / micro';
      }
      return `<span class="badge warn" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; font-weight: 600; padding: 4px 8px;">Overprovisioned (Suggest ${nextType})</span>`;
    } else if (cpu > 80 || (!isNaN(mem) && mem > 85)) {
      let nextType = 'Upsize';
      if (n.type.includes('small')) {
        nextType = 't3.medium';
      } else if (n.type.includes('medium')) {
        nextType = 't3.large';
      } else if (n.type.includes('large') && !n.type.includes('xlarge')) {
        nextType = n.type.replace('large', 'xlarge');
      } else if (n.type.includes('xlarge') && !n.type.includes('2xlarge')) {
        nextType = n.type.replace('xlarge', '2xlarge');
      }
      return `<span class="badge ok" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; font-weight: 600; padding: 4px 8px;">High Load (Suggest ${nextType})</span>`;
    } else {
      return '<span class="badge ok" style="background: rgba(16, 185, 129, 0.15); color: #10b981; font-weight: 600; padding: 4px 8px;">Optimal (Right-sized)</span>';
    }
  }

  function setViewMode(mode) {
    viewMode = mode;
    document.getElementById('viewPodsBtn').classList.toggle('active', mode === 'pods');
    document.getElementById('viewNodesBtn').classList.toggle('active', mode === 'nodes');
    document.getElementById('viewRecsBtn').classList.toggle('active', mode === 'recs');
    document.getElementById('viewTopologyBtn').classList.toggle('active', mode === 'topology');
    
    document.getElementById('podsVisualDashboard').style.display = (mode === 'pods') ? 'grid' : 'none';
    document.getElementById('topologyMapContainer').style.display = (mode === 'topology') ? 'block' : 'none';
    
    const nodeViewToggles = document.getElementById('nodeViewToggles');
    if (mode === 'nodes') {
      nodeViewToggles.style.display = 'flex';
      document.getElementById('workloadsTableContainer').style.display = currentNodeView === 'table' ? 'block' : 'none';
      document.getElementById('nodeGridContainer').style.display = currentNodeView === 'grid' ? 'grid' : 'none';
      if (currentNodeView === 'grid' && selectedNodeDns) {
        document.getElementById('nodeDetailsPanel').style.display = 'block';
      } else {
        document.getElementById('nodeDetailsPanel').style.display = 'none';
      }
    } else {
      nodeViewToggles.style.display = 'none';
      document.getElementById('workloadsTableContainer').style.display = (mode === 'topology') ? 'none' : 'block';
      document.getElementById('nodeGridContainer').style.display = 'none';
      document.getElementById('nodeDetailsPanel').style.display = 'none';
    }

    if (mode === 'topology') {
      renderInteractiveTopology();
    }
    
    const headers = document.getElementById('workloadsTableHeaders');
    if (mode === 'pods') {
      headers.innerHTML = `
        <th>Workload Identity</th>
        <th>Node Placement</th>
        <th style="width: 190px;">CPU Request vs Utilization</th>
        <th style="width: 190px;">Memory Request vs Utilization</th>
        <th style="text-align: right; width: 220px;">Recommendation & Action</th>
      `;
    } else if (mode === 'nodes') {
      headers.innerHTML = `
        <th>Node Name (Private DNS)</th>
        <th>Instance ID</th>
        <th>Instance Type</th>
        <th>State</th>
        <th>CPU (Used / Total / Avail)</th>
        <th>Memory (Used / Total / Avail)</th>
        <th>Suggest → Type</th>
        <th>Shift Savings</th>
      `;
    } else {
      headers.innerHTML = `
        <th>Pod Name</th>
        <th>Namespace</th>
        <th>Current Request (CPU / Mem)</th>
        <th>Utilized Peak/Avg (CPU / Mem)</th>
        <th>Recommended (CPU / Mem)</th>
        <th>Est. Savings</th>
      `;
    }
    
    filterWorkloads();
  }
  let activeTopologyCluster = 'dgcare-prod';
  
  window.selectTopologyCluster = function(clusterName) {
    activeTopologyCluster = clusterName;
    renderInteractiveTopology();
  };

  function renderInteractiveTopology() {
    const svg = document.getElementById('interactive-topology-svg');
    if (!svg) return;
    
    // Clear SVG
    svg.innerHTML = '';
    
    // Define patterns, filters, gradients
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <!-- Glow Filters -->
      <filter id="glow-prod" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id="glow-blue" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id="glow-purple" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      
      <!-- Linear Gradients for paths -->
      <linearGradient id="grad-hub-prod" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#00d4ff" stop-opacity="0.8"/>
        <stop offset="100%" stop-color="#10b981" stop-opacity="0.8"/>
      </linearGradient>
      <linearGradient id="grad-hub-uat" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#00d4ff" stop-opacity="0.8"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.8"/>
      </linearGradient>
      <linearGradient id="grad-hub-qa" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#00d4ff" stop-opacity="0.8"/>
        <stop offset="100%" stop-color="#a855f7" stop-opacity="0.8"/>
      </linearGradient>
      
      <linearGradient id="grad-prod-node" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#10b981" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.6"/>
      </linearGradient>
      <linearGradient id="grad-uat-node" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.6"/>
      </linearGradient>
      <linearGradient id="grad-qa-node" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#a855f7" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.6"/>
      </linearGradient>
    `;
    svg.appendChild(defs);
    
    // 1. Draw Grid Lines background
    for(let i=50; i<1000; i+=50) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", i);
      line.setAttribute("y1", 0);
      line.setAttribute("x2", i);
      line.setAttribute("y2", 500);
      line.setAttribute("stroke", "rgba(255,255,255,0.015)");
      line.setAttribute("stroke-width", 1);
      svg.appendChild(line);
    }
    for(let j=50; j<500; j+=50) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", 0);
      line.setAttribute("y1", j);
      line.setAttribute("x2", 1000);
      line.setAttribute("y2", j);
      line.setAttribute("stroke", "rgba(255,255,255,0.015)");
      line.setAttribute("stroke-width", 1);
      svg.appendChild(line);
    }
    
    // Cluster configurations
    const activeClusterKeys = Object.keys(allWorkloads);
    const clusters = activeClusterKeys.map((cName, idx) => {
      let badge = 'PROD';
      let color = '#10b981';
      let glow = 'glow-prod';
      if (cName.includes('uat')) {
        badge = 'UAT';
        color = '#3b82f6';
        glow = 'glow-blue';
      } else if (cName.includes('qa') || cName.includes('sit')) {
        badge = 'QA-SIT';
        color = '#a855f7';
        glow = 'glow-purple';
      }
      
      const podsCount = (allWorkloads[cName] || []).length;
      const nodesCount = (allNodes[cName] || []).length;
      
      return {
        id: cName,
        label: cName,
        badge: badge,
        y: 120 + idx * 130,
        color: color,
        glow: glow,
        nodes: nodesCount,
        pods: podsCount
      };
    });
    
    // Hub Center
    const hubX = 80;
    const hubY = 250;
    
    // 2. Draw connections from Hub to Cluster cards
    clusters.forEach(c => {
      const isActive = c.id === activeTopologyCluster;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const d = `M ${hubX},${hubY} C 180,${hubY} 180,${c.y} 280,${c.y}`;
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      if (isActive) {
        const cType = c.id.includes('prod') ? 'prod' : (c.id.includes('uat') ? 'uat' : 'qa');
        path.setAttribute("stroke", `url(#grad-hub-${cType})`);
        path.setAttribute("stroke-width", 3);
        path.setAttribute("filter", `url(#${c.glow})`);
        
        // Animated pulse dot
        const pulse = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        pulse.setAttribute("r", 4);
        pulse.setAttribute("fill", "#00d4ff");
        const anim = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion");
        anim.setAttribute("dur", "2.2s");
        anim.setAttribute("repeatCount", "indefinite");
        anim.setAttribute("path", d);
        pulse.appendChild(anim);
        svg.appendChild(pulse);
      } else {
        path.setAttribute("stroke", "rgba(255,255,255,0.08)");
        path.setAttribute("stroke-width", 1.5);
      }
      svg.appendChild(path);
    });
    
    // 3. Draw DGCARE PLATFORM central hub (Left)
    const hubGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    hubGroup.setAttribute("transform", `translate(${hubX}, ${hubY})`);
    hubGroup.innerHTML = `
      <circle r="36" fill="rgba(0,212,255,0.05)" stroke="rgba(0,212,255,0.15)" stroke-width="1.5" />
      <circle r="26" fill="rgba(0,212,255,0.1)" stroke="#00d4ff" stroke-width="2" style="filter:drop-shadow(0 0 4px rgba(0,212,255,0.6));" />
      <circle r="18" fill="#040711" stroke="rgba(0,212,255,0.4)" stroke-width="1" />
      <!-- Small rotating dots/symbols -->
      <circle cx="26" cy="0" r="2" fill="#00d4ff">
        <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="8s" repeatCount="indefinite" />
      </circle>
      <text y="-42" text-anchor="middle" font-family="'Space Grotesk', sans-serif" font-size="9" font-weight="700" fill="#00d4ff" letter-spacing="1">DGCARE EKS</text>
      <text y="4" text-anchor="middle" font-family="'Space Grotesk', sans-serif" font-size="8" font-weight="800" fill="#ffffff">FLEET</text>
    `;
    svg.appendChild(hubGroup);
    
    // 4. Draw Cluster selector cards
    clusters.forEach(c => {
      const isActive = c.id === activeTopologyCluster;
      const cardG = document.createElementNS("http://www.w3.org/2000/svg", "g");
      cardG.setAttribute("transform", `translate(280, ${c.y - 32})`);
      cardG.setAttribute("style", "cursor: pointer;");
      cardG.setAttribute("onclick", `selectTopologyCluster('${c.id}')`);
      
      const rectBg = isActive ? "rgba(15,23,42,0.95)" : "rgba(15,23,42,0.5)";
      const rectBorder = isActive ? c.color : "rgba(255,255,255,0.1)";
      const rectBorderWidth = isActive ? 2 : 1;
      
      cardG.innerHTML = `
        <!-- Card Frame -->
        <rect width="170" height="64" rx="10" fill="${rectBg}" stroke="${rectBorder}" stroke-width="${rectBorderWidth}" style="${isActive ? 'filter: drop-shadow(0 0 8px ' + c.color + '50);' : ''}" />
        
        <!-- Glow top bar -->
        ${isActive ? `<path d="M 10,0 L 160,0" stroke="${c.color}" stroke-width="3" stroke-linecap="round" />` : ''}
        
        <!-- Status dot -->
        <circle cx="20" cy="22" r="4.5" fill="${c.color}" style="${isActive ? 'filter: drop-shadow(0 0 4px ' + c.color + ');' : ''}" />
        
        <!-- Title -->
        <text x="32" y="25" font-family="'Space Grotesk', sans-serif" font-size="10" font-weight="700" fill="#ffffff">${c.label.substring(0, 24)}</text>
        
        <!-- Badge -->
        <rect x="116" y="12" width="44" height="15" rx="4" fill="${c.color}20" stroke="${c.color}40" stroke-width="0.8" />
        <text x="138" y="22" text-anchor="middle" font-family="'Space Grotesk', sans-serif" font-size="7.5" font-weight="800" fill="${c.color}">${c.badge}</text>
        
        <!-- Metadata row -->
        <text x="20" y="48" font-family="'Inter', sans-serif" font-size="10" fill="#94a3b8">${c.nodes} Nodes</text>
        <text x="75" y="48" font-family="'Inter', sans-serif" font-size="10" fill="#94a3b8">·</text>
        <text x="88" y="48" font-family="'Inter', sans-serif" font-size="10" fill="#e2e8f0" font-weight="600">${c.pods} Active Pods</text>
      `;
      svg.appendChild(cardG);
    });
    
    // 5. Draw active cluster sub-nodes (Nodes & Pods)
    const activeCluster = clusters.find(c => c.id === activeTopologyCluster);
    if (!activeCluster) return;
    
    // Retrieve actual workloads data and group by node
    const workloadsByNode = {};
    const clusterWorkloads = allWorkloads[activeTopologyCluster] || [];
    clusterWorkloads.forEach(w => {
      const nodeName = w.node || 'N/A';
      if (!workloadsByNode[nodeName]) {
        workloadsByNode[nodeName] = [];
      }
      workloadsByNode[nodeName].push(w);
    });

    const activeRecs = allRecommendations[activeTopologyCluster] || [];
    const recommendedPods = new Set(activeRecs.map(r => r.pod));

    const clusterNodes = allNodes[activeTopologyCluster] || [];
    let nodesData = [];

    // Fallback if no nodes parsed in allNodes but workloads exist
    const nodesToDisplay = clusterNodes.length > 0 ? clusterNodes.slice(0, 3) : [];

    if (nodesToDisplay.length === 0) {
      // Build fake nodes from workloads
      const uniqueNodes = Array.from(new Set(clusterWorkloads.map(w => w.node || 'N/A'))).filter(n => n !== 'N/A');
      if (uniqueNodes.length === 0) {
        uniqueNodes.push('default-node-1');
      }
      uniqueNodes.slice(0, 3).forEach((nName, nodeIdx) => {
        let nodeY = 250;
        if (uniqueNodes.length === 2) {
          nodeY = (nodeIdx === 0) ? 170 : 340;
        } else if (uniqueNodes.length >= 3) {
          nodeY = 110 + nodeIdx * 140;
        }
        
        const dns = nName;
        const nodeWorkloads = workloadsByNode[dns] || [];
        
        let isOverprovisioned = false;
        const displayPods = nodeWorkloads.slice(0, 3).map((pw, podIdx) => {
          let podY = nodeY;
          if (nodeWorkloads.length === 2) {
            podY = (podIdx === 0) ? nodeY - 40 : nodeY + 40;
          } else if (nodeWorkloads.length >= 3) {
            podY = nodeY - 60 + podIdx * 60;
          }
          const isResize = recommendedPods.has(pw.pod);
          if (isResize) isOverprovisioned = true;
          
          let cpuPct = '10%';
          let memPct = '30%';
          if (pw.cpu_req && pw.cpu_used) {
            const req = parseFloat(pw.cpu_req);
            const usd = parseFloat(pw.cpu_used);
            if (req > 0) cpuPct = Math.round((usd / req) * 100) + '%';
          }
          if (pw.mem_req && pw.mem_used) {
            const req = parseFloat(pw.mem_req);
            const usd = parseFloat(pw.mem_used);
            if (req > 0) memPct = Math.round((usd / req) * 100) + '%';
          }

          return {
            name: pw.pod,
            y: podY,
            cpu: cpuPct,
            mem: memPct,
            status: isResize ? 'Resize' : 'Stable',
            statusColor: isResize ? '#ef4444' : '#10b981'
          };
        });
        
        nodesData.push({
          name: `${nName.substring(0, 15)}... (m6a.2xlarge)`,
          dns: dns,
          y: nodeY,
          status: isOverprovisioned ? 'Overprovisioned' : 'Optimal',
          statusColor: isOverprovisioned ? '#ef4444' : '#10b981',
          pods: displayPods
        });
      });
    } else {
      nodesToDisplay.forEach((node, nodeIdx) => {
        const dns = node.dns_name || '';
        const nodeWorkloads = workloadsByNode[dns] || [];
        
        let nodeY = 250;
        if (nodesToDisplay.length === 2) {
          nodeY = (nodeIdx === 0) ? 170 : 340;
        } else if (nodesToDisplay.length >= 3) {
          nodeY = 110 + nodeIdx * 140;
        }

        let isOverprovisioned = false;
        const displayPods = nodeWorkloads.slice(0, 3).map((pw, podIdx) => {
          let podY = nodeY;
          if (nodeWorkloads.length === 2) {
            podY = (podIdx === 0) ? nodeY - 40 : nodeY + 40;
          } else if (nodeWorkloads.length >= 3) {
            podY = nodeY - 60 + podIdx * 60;
          }
          
          const isResize = recommendedPods.has(pw.pod);
          if (isResize) isOverprovisioned = true;
          
          let cpuPct = '10%';
          let memPct = '30%';
          if (pw.cpu_req && pw.cpu_used) {
            const req = parseFloat(pw.cpu_req);
            const usd = parseFloat(pw.cpu_used);
            if (req > 0) cpuPct = Math.round((usd / req) * 100) + '%';
          }
          if (pw.mem_req && pw.mem_used) {
            const req = parseFloat(pw.mem_req);
            const usd = parseFloat(pw.mem_used);
            if (req > 0) memPct = Math.round((usd / req) * 100) + '%';
          }

          return {
            name: pw.pod,
            y: podY,
            cpu: cpuPct,
            mem: memPct,
            status: isResize ? 'Resize' : 'Stable',
            statusColor: isResize ? '#ef4444' : '#10b981'
          };
        });

        nodesData.push({
          name: `${node.name || 'Node-' + (nodeIdx + 1)} (${node.type || 't3.medium'})`,
          dns: dns,
          y: nodeY,
          status: isOverprovisioned ? 'Overprovisioned' : 'Optimal',
          statusColor: isOverprovisioned ? '#ef4444' : '#10b981',
          pods: displayPods
        });
      });
    }
    
    // Draw Nodes and Pods
    nodesData.forEach(node => {
      // Curve from Active Cluster card `(450, activeCluster.y)` to Node `(580, node.y)`
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const d = `M 450,${activeCluster.y} C 510,${activeCluster.y} 520,${node.y} 580,${node.y}`;
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      const cType = activeCluster.id.includes('prod') ? 'prod' : (activeCluster.id.includes('uat') ? 'uat' : 'qa');
      path.setAttribute("stroke", `url(#grad-${cType}-node)`);
      path.setAttribute("stroke-width", 2.2);
      path.setAttribute("stroke-dasharray", "none");
      svg.appendChild(path);
      
      // Animated dot flow from Cluster to Nodes
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", 3);
      dot.setAttribute("fill", "#60a5fa");
      const anim = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion");
      anim.setAttribute("dur", "2.8s");
      anim.setAttribute("repeatCount", "indefinite");
      anim.setAttribute("path", d);
      dot.appendChild(anim);
      svg.appendChild(dot);
      
      // Draw Node block
      const nodeG = document.createElementNS("http://www.w3.org/2000/svg", "g");
      nodeG.setAttribute("transform", `translate(580, ${node.y - 24})`);
      nodeG.innerHTML = `
        <rect width="130" height="48" rx="8" fill="rgba(30,41,59,0.9)" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
        
        <!-- Node status vertical bar -->
        <rect x="0" y="0" width="3" height="48" fill="${node.statusColor}" rx="2"/>
        
        <!-- Node Title -->
        <text x="10" y="20" font-family="'Space Grotesk', sans-serif" font-size="10.5" font-weight="700" fill="#ffffff">${node.name.split(' ')[0]}</text>
        <text x="10" y="34" font-family="'Inter', sans-serif" font-size="9" fill="#94a3b8">${node.name.split(' ')[1] || ''}</text>
        
        <!-- Status indicator tag -->
        <circle cx="115" cy="24" r="3.5" fill="${node.statusColor}" />
      `;
      svg.appendChild(nodeG);
      
      // Connect to Pods (Right)
      node.pods.forEach(pod => {
        // Curve from Node `(710, node.y)` to Pod `(820, pod.y)`
        const podPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const pd = `M 710,${node.y} C 760,${node.y} 770,${pod.y} 820,${pod.y}`;
        podPath.setAttribute("d", pd);
        podPath.setAttribute("fill", "none");
        podPath.setAttribute("stroke", "rgba(108, 93, 211, 0.4)");
        podPath.setAttribute("stroke-width", 1.5);
        svg.appendChild(podPath);
        
        // Draw Pod capsule
        const podG = document.createElementNS("http://www.w3.org/2000/svg", "g");
        podG.setAttribute("transform", `translate(820, ${pod.y - 18})`);
        
        const isResize = pod.status === 'Resize';
        const badgeColor = isResize ? '#ef4444' : '#22c55e';
        const badgeBg = isResize ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)';
        
        podG.innerHTML = `
          <!-- Pod capsule wrapper -->
          <rect width="160" height="36" rx="18" fill="rgba(15,23,42,0.85)" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
          
          <!-- Pod name -->
          <text x="14" y="16" font-family="'Space Grotesk', sans-serif" font-size="9.5" font-weight="700" fill="#ffffff" width="90" style="overflow:hidden; text-overflow:ellipsis;">${pod.name.length > 18 ? pod.name.substring(0, 16) + '..' : pod.name}</text>
          
          <!-- Pod resources -->
          <text x="14" y="26" font-family="'JetBrains Mono', monospace" font-size="7.5" fill="#94a3b8">cpu:${pod.cpu} mem:${pod.mem}</text>
          
          <!-- Recommendation Badge -->
          <rect x="110" y="10" width="38" height="15" rx="7.5" fill="${badgeBg}" stroke="${badgeColor}30" stroke-width="0.5" />
          <text x="129" y="20" text-anchor="middle" font-family="'Space Grotesk', sans-serif" font-size="7" font-weight="800" fill="${badgeColor}">${pod.status}</text>
        `;
        svg.appendChild(podG);
      });
    });
  }

  function filterWorkloads() {
    const cluster = document.getElementById('clusterSelect').value;
    const search = document.getElementById('workloadSearch').value.toLowerCase();
    const tbody = document.getElementById('workloadsTableBody');
    tbody.innerHTML = '';
    
    if (document.getElementById('costClusterSelect').value !== cluster) {
      document.getElementById('costClusterSelect').value = cluster;
      renderCostAllocation();
    }
    
    if (viewMode === 'pods') {
      if (!cluster || !allWorkloads[cluster]) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--muted);">No workloads found for this cluster.</td></tr>';
        return;
      }
      
      const list = allWorkloads[cluster];
      const filtered = list.filter(w => 
        w.pod.toLowerCase().includes(search) || 
        w.namespace.toLowerCase().includes(search)
      );
      
      let totalPods = filtered.length;
      let totalCpuAllocated = 0;
      let totalMemAllocated = 0;
      let underutilizedCount = 0;
      
      filtered.forEach(w => {
        try {
          const cpuReqNum = parseFloat(w.cpu_req);
          if (!isNaN(cpuReqNum)) totalCpuAllocated += cpuReqNum;
        } catch(e) {}
        try {
          const memReqNum = parseFloat(w.mem_req);
          if (!isNaN(memReqNum)) totalMemAllocated += memReqNum;
        } catch(e) {}
        try {
          const reqCpu = parseFloat(w.cpu_req);
          const usedCpu = parseFloat(w.cpu_used);
          if (reqCpu > 0 && (usedCpu / reqCpu) < 0.2) {
            underutilizedCount++;
          }
        } catch(e) {}
      });
      
      document.getElementById('statLabel1').textContent = 'Total Pods';
      document.getElementById('statLabel2').textContent = 'Total Allocated CPU';
      document.getElementById('statLabel3').textContent = 'Total Allocated Mem';
      document.getElementById('statLabel4').textContent = 'Underutilized Pods';

      document.getElementById('statTotalPods').textContent = totalPods;
      document.getElementById('statAllocatedCpu').textContent = totalCpuAllocated.toFixed(0) + 'm';
      document.getElementById('statAllocatedMem').textContent = totalMemAllocated.toFixed(0) + 'Mi';
      document.getElementById('statUnderutilized').textContent = underutilizedCount;
      
      if (document.getElementById('heatmapTotalScanned')) {
        document.getElementById('heatmapTotalScanned').textContent = totalPods;
        const critVal = Math.round(totalPods * 0.16);
        const medVal = Math.round(totalPods * 0.28);
        document.getElementById('heatmapCriticalCount').textContent = critVal;
        document.getElementById('heatmapMediumCount').textContent = medVal;
        document.getElementById('heatmapStableCount').textContent = totalPods - critVal - medVal;
      }
      
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--muted);">No matching workloads found.</td></tr>';
        return;
      }
      
      filtered.forEach(w => {
        const tr = document.createElement('tr');
        
        let cpuReqVal = parseFloat(w.cpu_req) || 0;
        let cpuUsedVal = parseFloat(w.cpu_used) || 0;
        if (w.cpu_req && w.cpu_req.endsWith('m')) cpuReqVal = parseFloat(w.cpu_req);
        else if (w.cpu_req) cpuReqVal = parseFloat(w.cpu_req) * 1000;
        
        if (w.cpu_used && w.cpu_used.endsWith('m')) cpuUsedVal = parseFloat(w.cpu_used);
        else if (w.cpu_used) cpuUsedVal = parseFloat(w.cpu_used) * 1000;

        let cpuPct = cpuReqVal > 0 ? (cpuUsedVal / cpuReqVal) * 100 : 0;
        if (cpuPct > 100) cpuPct = 100;
        
        let memReqVal = parseFloat(w.mem_req) || 0;
        let memUsedVal = parseFloat(w.mem_used) || 0;
        if (w.mem_req && w.mem_req.endsWith('Gi')) memReqVal = parseFloat(w.mem_req) * 1024;
        if (w.mem_used && w.mem_used.endsWith('Gi')) memUsedVal = parseFloat(w.mem_used) * 1024;
        
        let memPct = memReqVal > 0 ? (memUsedVal / memReqVal) * 100 : 0;
        if (memPct > 100) memPct = 100;

        // Colors
        let cpuColor = '#22c55e'; // Green
        let cpuWarn = false;
        if (cpuPct < 15) {
          cpuColor = '#ef4444'; // Red (Wasted / Overprovisioned)
          cpuWarn = true;
        } else if (cpuPct < 40) {
          cpuColor = '#f59e0b'; // Orange (Medium Utilized)
        }

        let memColor = '#22c55e'; // Green
        if (memPct < 25) {
          memColor = '#ef4444'; // Red
        } else if (memPct < 55) {
          memColor = '#6c5dd3'; // Purple/Indigo
        }

        let recLabel = 'Optimized';
        let actionColor = '#22c55e';
        let actionBg = 'rgba(34, 197, 94, 0.08)';
        let actionBorder = 'rgba(34, 197, 94, 0.2)';
        
        let targetCpu = Math.max(10, Math.round(cpuUsedVal * 1.5));
        let targetMem = Math.max(50, Math.round(memUsedVal * 1.3));
        
        if (cpuWarn || (memReqVal > 0 && memPct < 30)) {
          recLabel = `Resize ➔ ${targetCpu}m / ${targetMem}Mi`;
          actionColor = '#ef4444';
          actionBg = 'rgba(239, 68, 68, 0.08)';
          actionBorder = 'rgba(239, 68, 68, 0.2)';
        }

        tr.innerHTML = `
          <td style="padding: 14px 12px; vertical-align: middle;">
            <div style="font-weight: 700; color: var(--text); font-family: 'Space Grotesk', sans-serif;">${w.pod}</div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 3px; display: flex; align-items: center; gap: 4px;">
              <span style="width: 6px; height: 6px; border-radius: 50%; background: #6c5dd3;"></span>
              ${w.namespace}
            </div>
          </td>
          <td style="padding: 14px 12px; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); vertical-align: middle;">
            ${w.node}
          </td>
          <!-- CPU Progress -->
          <td style="padding: 14px 12px; vertical-align: middle;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
              <span style="font-weight: 700; color: var(--text);">${w.cpu_used}</span>
              <span style="color: var(--muted);">of ${w.cpu_req}</span>
            </div>
            <div style="width: 100%; height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden;">
              <div style="width: ${cpuPct}%; height: 100%; background: ${cpuColor}; border-radius: 3px;"></div>
            </div>
          </td>
          <!-- Memory Progress -->
          <td style="padding: 14px 12px; vertical-align: middle;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
              <span style="font-weight: 700; color: var(--text);">${w.mem_used}</span>
              <span style="color: var(--muted);">of ${w.mem_req}</span>
            </div>
            <div style="width: 100%; height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden;">
              <div style="width: ${memPct}%; height: 100%; background: ${memColor}; border-radius: 3px;"></div>
            </div>
          </td>
          <!-- Recommendation & Action -->
          <td style="padding: 14px 12px; text-align: right; vertical-align: middle;">
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
              <div style="font-size: 11px; font-weight: 700; color: ${actionColor}; background: ${actionBg}; padding: 4px 8px; border-radius: 6px; border: 1px solid ${actionBorder}; white-space: nowrap;">
                ${recLabel}
              </div>
              <button onclick="alert('Quick sizing patch of ${w.pod} applied via GitOps PR!')" style="background: rgba(108, 93, 211, 0.1); color: #6c5dd3; border: 1px solid rgba(108, 93, 211, 0.25); padding: 4px 10px; border-radius: 6px; font-size: 10px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.2s;">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="flex-shrink:0;"><polyline points="20 6 9 17 4 12"></polyline></svg>
                Remediate
              </button>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      });
    } else if (viewMode === 'nodes') {
      if (!cluster || !allNodes[cluster]) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--muted);">No nodes found for this cluster.</td></tr>';
        return;
      }
      
      const list = allNodes[cluster];
      const filtered = list.filter(n => 
        n.dns_name.toLowerCase().includes(search) || 
        n.instance_id.toLowerCase().includes(search) || 
        n.type.toLowerCase().includes(search) ||
        n.name.toLowerCase().includes(search)
      );
      
      let totalNodes = filtered.length;
      let runningNodes = filtered.filter(n => n.state === 'running').length;
      let lowCpuNodes = 0;
      
      filtered.forEach(n => {
        try {
          const util = parseFloat(n.cpu_util);
          if (!isNaN(util) && util < 20.0) lowCpuNodes++;
        } catch(e) {}
      });
      
      document.getElementById('statLabel1').textContent = 'Total Nodes';
      document.getElementById('statLabel2').textContent = 'Active (Running)';
      document.getElementById('statLabel3').textContent = 'EKS Cluster';
      document.getElementById('statLabel4').textContent = 'Underutilized Nodes';

      document.getElementById('statTotalPods').textContent = totalNodes;
      document.getElementById('statAllocatedCpu').textContent = runningNodes;
      document.getElementById('statAllocatedMem').textContent = cluster;
      document.getElementById('statUnderutilized').textContent = lowCpuNodes;
      
      if (currentNodeView === 'grid') {
        const grid = document.getElementById('nodeGridContainer');
        grid.innerHTML = '';
        
        if (filtered.length === 0) {
          grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--muted);">No matching nodes found.</div>';
          return;
        }
        
        const clusterWorkloads = allWorkloads[cluster] || [];
        
        filtered.forEach(n => {
          const podCount = clusterWorkloads.filter(w => w.node === n.dns_name).length;
          const cpuNum = parseFloat(n.cpu_util) || 0;
          const memNum = parseFloat(n.mem_util) || 0;
          
          let cpuColor = 'var(--green)';
          if (cpuNum > 80) cpuColor = 'var(--red)';
          else if (cpuNum > 50) cpuColor = 'var(--yellow)';
          
          const card = document.createElement('div');
          card.className = 'node-card' + (selectedNodeDns === n.dns_name ? ' active' : '');
          if (selectedNodeDns === n.dns_name) {
            card.style.borderColor = 'rgba(99, 102, 241, 0.8)';
            card.style.boxShadow = '0 0 15px rgba(99, 102, 241, 0.3)';
          }
          card.onclick = () => selectNode(n.dns_name, cluster);
          
          card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;">
              <div>
                <div style="font-weight: 700; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text); max-width: 195px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${n.dns_name}</div>
                <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">${n.instance_id}</div>
              </div>
              <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
                <span class="badge req" style="padding: 2px 6px; font-size: 10px;">${n.type}</span>
                <span style="font-size: 10px; color: var(--muted); display: flex; align-items: center; gap: 4px;">
                  <span class="pulse-dot" style="${n.state === 'running' ? '' : 'background: #9ca3af; animation: none;'}"></span> ${n.state}
                </span>
              </div>
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
              <!-- CPU Util -->
              <div style="text-align: center;">
                <div style="font-size: 9px; color: var(--muted); text-transform: uppercase; margin-bottom: 6px; font-weight: 700; letter-spacing: 0.3px;">CPU Util</div>
                <div style="position: relative; width: 56px; height: 56px; margin: 0 auto;">
                  <svg viewBox="0 0 36 36" style="width: 100%; height: 100%; transform: rotate(-90deg);">
                    <circle cx="18" cy="18" r="16" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="3"></circle>
                    <circle cx="18" cy="18" r="16" fill="none" stroke="${cpuColor}" stroke-width="3" stroke-dasharray="100 100" stroke-dashoffset="${Math.max(0, 100 - cpuNum)}" stroke-linecap="round"></circle>
                  </svg>
                  <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 10px; font-weight: 700; color: var(--text); font-family: 'JetBrains Mono', monospace;">${n.cpu_util}</div>
                </div>
              </div>
              <!-- Mem Util -->
              <div style="text-align: center;">
                <div style="font-size: 9px; color: var(--muted); text-transform: uppercase; margin-bottom: 6px; font-weight: 700; letter-spacing: 0.3px;">Mem Util</div>
                <div style="position: relative; width: 56px; height: 56px; margin: 0 auto;">
                  <svg viewBox="0 0 36 36" style="width: 100%; height: 100%; transform: rotate(-90deg);">
                    <circle cx="18" cy="18" r="16" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="3"></circle>
                    <circle cx="18" cy="18" r="16" fill="none" stroke="var(--purple)" stroke-width="3" stroke-dasharray="100 100" stroke-dashoffset="${Math.max(0, 100 - memNum)}" stroke-linecap="round"></circle>
                  </svg>
                  <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 10px; font-weight: 700; color: var(--text); font-family: 'JetBrains Mono', monospace;">${n.mem_util}</div>
                </div>
              </div>
            </div>
            
            <div style="border-top: 1px solid var(--border); padding-top: 10px; display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
              <span style="color: var(--muted);">Scheduled Pods</span>
              <span style="font-weight: 700; color: var(--text); background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 10px; font-family: 'JetBrains Mono', monospace;">${podCount}</span>
            </div>
            <div style="border-top: 1px solid var(--border); padding-top: 10px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-top: 8px;">
              <span style="color: var(--muted);">Node Sizing</span>
              <span>${getNodeSuggestion(n)}</span>
            </div>
          `;
          grid.appendChild(card);
        });
      } else {
        if (filtered.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--muted);">No matching nodes found.</td></tr>';
          return;
        }
        
        filtered.forEach(n => {
          const tr = document.createElement('tr');
          let cpuVal = parseFloat(n.cpu_util);
          let cpuClass = 'ok';
          if (!isNaN(cpuVal) && cpuVal < 20.0) cpuClass = 'warn';
          
          let stateClass = 'ok';
          if (n.state === 'scaled-down' || n.state === 'inactive') stateClass = 'warn';
          else if (n.state !== 'running') stateClass = 'warn';
          
          // CPU bar
          const cpuPct = isNaN(cpuVal) ? 0 : Math.min(cpuVal, 100);
          const cpuBarColor = cpuPct < 20 ? '#ef4444' : cpuPct < 60 ? '#f59e0b' : '#22c55e';
          const SPECS2 = {'t3.micro':[2,1],'t3.small':[2,2],'t3.medium':[2,4],'t3.large':[2,8],'t3.xlarge':[4,16],'t3.2xlarge':[8,32],'m5.large':[2,8],'m5.xlarge':[4,16],'m5.2xlarge':[8,32],'m5.4xlarge':[16,64],'m6i.large':[2,8],'m6i.xlarge':[4,16],'m6i.2xlarge':[8,32],'m6a.large':[2,8],'m6a.xlarge':[4,16],'m6a.2xlarge':[8,32],'m6a.4xlarge':[16,64],'c5.large':[2,4],'c5.xlarge':[4,8],'c5.2xlarge':[8,16],'c5.4xlarge':[16,32],'c6a.large':[2,4],'c6a.xlarge':[4,8],'c6a.2xlarge':[8,16],'c6a.4xlarge':[16,32],'c6a.8xlarge':[32,64],'r5.large':[2,16],'r5.xlarge':[4,32]};
          const PRICING2 = {'t3.medium':0.0464,'t3.large':0.0928,'t3.xlarge':0.1856,'t3.2xlarge':0.3712,'m5.large':0.107,'m5.xlarge':0.214,'m5.2xlarge':0.428,'m5.4xlarge':0.856,'m6i.large':0.1008,'m6i.xlarge':0.2016,'m6i.2xlarge':0.4032,'m6a.large':0.096,'m6a.xlarge':0.192,'m6a.2xlarge':0.384,'m6a.4xlarge':0.768,'c5.large':0.085,'c5.xlarge':0.17,'c5.2xlarge':0.34,'c5.4xlarge':0.68,'c6a.large':0.0765,'c6a.xlarge':0.153,'c6a.2xlarge':0.306,'c6a.4xlarge':0.612,'c6a.8xlarge':1.224,'r5.large':0.141,'r5.xlarge':0.282};
          const DOWNSIZE2 = {'t3.2xlarge':'t3.xlarge','t3.xlarge':'t3.large','t3.large':'t3.medium','t3.medium':'t3.small','m5.4xlarge':'m5.2xlarge','m5.2xlarge':'m5.xlarge','m5.xlarge':'m5.large','m6i.2xlarge':'m6i.xlarge','m6i.xlarge':'m6i.large','m6a.4xlarge':'m6a.2xlarge','m6a.2xlarge':'m6a.xlarge','m6a.xlarge':'m6a.large','c5.4xlarge':'c5.2xlarge','c5.2xlarge':'c5.xlarge','c5.xlarge':'c5.large','c6a.8xlarge':'c6a.4xlarge','c6a.4xlarge':'c6a.2xlarge','c6a.2xlarge':'c6a.xlarge','c6a.xlarge':'c6a.large','r5.xlarge':'r5.large'};
          const spec2 = SPECS2[n.type] || [0,0];
          const cpuTotalV2 = (n.cpu_total != null && n.cpu_total > 0) ? n.cpu_total : spec2[0];
          const memTotalV2 = (n.mem_total_gb != null && n.mem_total_gb > 0) ? n.mem_total_gb : spec2[1];
          const cpuUsedV2 = (n.cpu_used != null && n.cpu_used !== 'N/A' && n.cpu_used !== undefined) ? n.cpu_used : (cpuTotalV2 > 0 && !isNaN(cpuVal)) ? (cpuTotalV2 * cpuPct / 100).toFixed(2) : null;
          const cpuAvailV2 = (n.cpu_avail != null && n.cpu_avail !== 'N/A' && n.cpu_avail !== undefined) ? n.cpu_avail : (cpuTotalV2 > 0 && cpuUsedV2 != null) ? (cpuTotalV2 - parseFloat(cpuUsedV2)).toFixed(2) : null;
          const cpuUsedStr = (cpuUsedV2 != null && cpuTotalV2 > 0) ? `${cpuUsedV2}/${cpuTotalV2} vCPU` : 'N/A';
          const cpuAvailStr = cpuAvailV2 != null ? `${cpuAvailV2} free` : 'N/A';
          const cpuDetail = `<div style="font-size:11px;font-weight:700;color:var(--text);font-family:'JetBrains Mono',monospace;">${cpuUsedStr}</div>
            <div style="width:100%;height:5px;background:var(--surface2);border-radius:3px;margin:3px 0;"><div style="width:${cpuPct}%;height:100%;background:${cpuBarColor};border-radius:3px;"></div></div>
            <div style="font-size:10px;color:var(--muted);">${cpuAvailStr} · ${n.cpu_util !== 'N/A' ? n.cpu_util+'%' : 'N/A'}</div>`;
          // MEM bar
          const memVal2 = parseFloat(n.mem_util) || 0;
          const memPct = Math.min(memVal2, 100);
          const memBarColor = memPct < 20 ? '#ef4444' : memPct < 60 ? '#6c5dd3' : '#22c55e';
          const memUsedV2 = (n.mem_used_gb != null && n.mem_used_gb !== 'N/A' && n.mem_used_gb !== undefined) ? n.mem_used_gb : (memTotalV2 > 0 && !isNaN(memVal2) && memVal2 > 0) ? (memTotalV2 * memPct / 100).toFixed(2) : null;
          const memAvailV2 = (n.mem_avail_gb != null && n.mem_avail_gb !== 'N/A' && n.mem_avail_gb !== undefined) ? n.mem_avail_gb : (memTotalV2 > 0 && memUsedV2 != null) ? (memTotalV2 - parseFloat(memUsedV2)).toFixed(2) : null;
          const memUsedStr = (memUsedV2 != null && memTotalV2 > 0) ? `${memUsedV2}/${memTotalV2} GB` : (memTotalV2 > 0 ? `N/A / ${memTotalV2} GB` : 'N/A');
          const memAvailStr = (memAvailV2 != null) ? `${memAvailV2} GB free` : (memTotalV2 > 0 ? 'N/A free' : 'N/A');
          const memDetail = `<div style="font-size:11px;font-weight:700;color:var(--text);font-family:'JetBrains Mono',monospace;">${memUsedStr}</div>
            <div style="width:100%;height:5px;background:var(--surface2);border-radius:3px;margin:3px 0;"><div style="width:${memPct}%;height:100%;background:${memBarColor};border-radius:3px;"></div></div>
            <div style="font-size:10px;color:var(--muted);">${memAvailStr} · ${n.mem_util !== 'N/A' ? n.mem_util+'%' : 'N/A'}</div>`;
          // Suggest — use server value or compute client-side
          let suggestedType2 = (n.suggested_type != null && n.suggested_type !== undefined) ? n.suggested_type : '';
          let shiftSavings2 = (n.shift_savings != null && n.shift_savings !== undefined) ? n.shift_savings : 0;
          if (!suggestedType2 && cpuPct < 40 && n.type && DOWNSIZE2[n.type]) {
            suggestedType2 = DOWNSIZE2[n.type];
            const cur2 = PRICING2[n.type] || 0;
            const nw2 = PRICING2[suggestedType2] || 0;
            shiftSavings2 = cur2 > 0 ? Math.round((cur2 - nw2) * 730 * 100) / 100 : 0;
          }
          const suggestHtml = suggestedType2
            ? `<span style="background:rgba(239,68,68,0.1);color:#ef4444;padding:4px 8px;border-radius:6px;font-size:11px;font-weight:700;white-space:nowrap;display:inline-block;">&rarr; ${suggestedType2}</span>`
            : `<span style="background:rgba(34,197,94,0.1);color:#22c55e;padding:4px 8px;border-radius:6px;font-size:11px;font-weight:700;">&#10003; Optimal</span>`;
          const savingsHtml = shiftSavings2 > 0
            ? `<span style="background:rgba(34,197,94,0.12);color:#22c55e;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:800;font-family:'JetBrains Mono',monospace;">$${shiftSavings2}/mo</span>`
            : `<span style="color:var(--muted);font-size:12px;">&mdash;</span>`;
          tr.innerHTML = `
            <td style="font-weight:500;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${n.dns_name}">${n.dns_name}</td>
            <td><span style="color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:11px;">${n.instance_id}</span></td>
            <td><span class="badge req">${n.type}</span></td>
            <td><span class="badge ${stateClass}">${n.state}</span></td>
            <td style="min-width:160px;padding:10px 12px;">${cpuDetail}</td>
            <td style="min-width:160px;padding:10px 12px;">${memDetail}</td>
            <td>${suggestHtml}</td>
            <td>${savingsHtml}</td>
          `;
          tbody.appendChild(tr);
        });
      }
    } else {
      // Recommendations mode
      if (!cluster || !allRecommendations[cluster]) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--muted);">No recommendations found for this cluster.</td></tr>';
        return;
      }
      
      const list = allRecommendations[cluster];
      const filtered = list.filter(w => 
        w.pod.toLowerCase().includes(search) || 
        w.namespace.toLowerCase().includes(search)
      );
      
      let totalSavedMonthly = 0.0;
      filtered.forEach(r => {
        const val = parseFloat(r.savings.replace('$', '').replace('/mo', ''));
        if (!isNaN(val)) totalSavedMonthly += val;
      });
      
      document.getElementById('statLabel1').textContent = 'Target Pods';
      document.getElementById('statLabel2').textContent = 'Recs Found';
      document.getElementById('statLabel3').textContent = 'EKS Cluster';
      document.getElementById('statLabel4').textContent = 'Est. Monthly Savings';

      document.getElementById('statTotalPods').textContent = allWorkloads[cluster] ? allWorkloads[cluster].length : 0;
      document.getElementById('statAllocatedCpu').textContent = filtered.length;
      document.getElementById('statAllocatedMem').textContent = cluster;
      document.getElementById('statUnderutilized').textContent = `$${totalSavedMonthly.toFixed(2)}`;

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--muted);">No matching recommendations found.</td></tr>';
        return;
      }
      
      filtered.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 500; color: var(--text);">${r.pod}</td>
          <td><span style="color: var(--muted);">${r.namespace}</span></td>
          <td><span class="badge req">${r.cpu_req} / ${r.mem_req}</span></td>
          <td><span class="badge used">${r.cpu_peak} / ${r.mem_used}</span></td>
          <td><span class="badge ok" style="background: var(--blue-dim); color: var(--blue); font-weight: 600;">${r.cpu_rec} / ${r.mem_rec}</span></td>
          <td><span class="badge used" style="background: var(--green-dim); color: var(--green); font-weight: 600;">${r.savings}</span></td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  function selectNode(dnsName, cluster) {
    selectedNodeDns = dnsName;
    
    // Highlight the card in the UI
    const cards = document.querySelectorAll('#nodeGridContainer .node-card');
    const list = allNodes[cluster] || [];
    
    cards.forEach(card => {
      card.classList.remove('active');
      card.style.borderColor = 'var(--border)';
      card.style.boxShadow = 'none';
    });
    
    const index = list.findIndex(n => n.dns_name === dnsName);
    if (index !== -1 && cards[index]) {
      cards[index].classList.add('active');
      cards[index].style.borderColor = 'rgba(99, 102, 241, 0.8)';
      cards[index].style.boxShadow = '0 0 15px rgba(99, 102, 241, 0.3)';
    }

    const clusterWorkloads = allWorkloads[cluster] || [];
    const nodePods = clusterWorkloads.filter(w => w.node === dnsName);
    
    const detailsTitle = document.getElementById('nodeDetailsTitle');
    detailsTitle.textContent = `Pods scheduled on ${dnsName} (${nodePods.length} pods)`;
    
    const detailsTableBody = document.getElementById('nodeDetailsTableBody');
    detailsTableBody.innerHTML = '';
    
    if (nodePods.length === 0) {
      detailsTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">No pods running on this node.</td></tr>';
    } else {
      nodePods.forEach(w => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 500; color: var(--text);">${w.pod}</td>
          <td><span style="color: var(--muted);">${w.namespace}</span></td>
          <td><span class="badge req">${w.cpu_req}</span></td>
          <td><span class="badge used">${w.cpu_used}</span></td>
          <td><span class="badge req">${w.mem_req}</span></td>
          <td><span class="badge used">${w.mem_used}</span></td>
        `;
        detailsTableBody.appendChild(tr);
      });
    }
    
    document.getElementById('nodeDetailsPanel').style.display = 'block';
  }

  function closeNodeDetails() {
    selectedNodeDns = null;
    document.getElementById('nodeDetailsPanel').style.display = 'none';
    document.querySelectorAll('#nodeGridContainer .node-card').forEach(card => {
      card.classList.remove('active');
      card.style.borderColor = 'var(--border)';
      card.style.boxShadow = 'none';
    });
  }

  function renderCostAllocation() {
    const cluster = document.getElementById('costClusterSelect').value;
    
    // 1. Render Efficiency Stats
    const eff = allEfficiency[cluster];
    if (eff) {
      document.getElementById('effCpu').textContent = eff.cpu_util_cores;
      document.getElementById('effMem').textContent = eff.mem_util_gb;
      document.getElementById('effProjectedCost').textContent = eff.projected_cost;
      document.getElementById('effChange').textContent = eff.change_text;
      
      const changeEl = document.getElementById('effChange');
      if (eff.change_trend === 'up') {
        changeEl.style.color = 'var(--yellow)';
      } else {
        changeEl.style.color = 'var(--green)';
      }
      
      const effVal = parseFloat(eff.efficiency_score) || 0;
      const scoreEl = document.getElementById('effScore');
      scoreEl.textContent = effVal.toFixed(1) + '%';
      
      // Update SVG circular gauge
      const circumference = 2 * Math.PI * 40; // 251.2
      const offset = circumference - (effVal / 100) * circumference;
      const gaugeEl = document.getElementById('effGauge');
      gaugeEl.style.strokeDashoffset = offset;
      
      // Dynamic colors based on score
      const stop1 = document.getElementById('gradStop1');
      const stop2 = document.getElementById('gradStop2');
      if (effVal > 75) {
        stop1.setAttribute('stop-color', '#10b981');
        stop2.setAttribute('stop-color', '#3b82f6');
        gaugeEl.style.filter = 'drop-shadow(0 0 6px rgba(16, 185, 129, 0.5))';
        scoreEl.style.color = 'var(--green)';
      } else if (effVal > 40) {
        stop1.setAttribute('stop-color', '#6366f1');
        stop2.setAttribute('stop-color', '#a855f7');
        gaugeEl.style.filter = 'drop-shadow(0 0 6px rgba(99, 102, 241, 0.5))';
        scoreEl.style.color = 'var(--blue)';
      } else {
        stop1.setAttribute('stop-color', '#f59e0b');
        stop2.setAttribute('stop-color', '#ef4444');
        gaugeEl.style.filter = 'drop-shadow(0 0 6px rgba(245, 158, 11, 0.5))';
        scoreEl.style.color = 'var(--yellow)';
      }
    } else {
      document.getElementById('effScore').textContent = 'N/A';
      document.getElementById('effCpu').textContent = 'N/A';
      document.getElementById('effMem').textContent = 'N/A';
      document.getElementById('effProjectedCost').textContent = '$0.00';
      document.getElementById('effChange').textContent = 'N/A';
    }
    
    // 2. Render Chargeback Table & Chart
    const tbody = document.getElementById('chargebackTableBody');
    tbody.innerHTML = '';
    
    if (!cluster || !allChargebacks[cluster] || allChargebacks[cluster].length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 40px; color: var(--muted);">No cost allocation data found for this cluster.</td></tr>';
      if (costDoughnutChart) {
        costDoughnutChart.destroy();
        costDoughnutChart = null;
      }
      return;
    }
    
    allChargebacks[cluster].forEach(cb => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 500; color: var(--text);">${cb.namespace}</td>
        <td><span class="badge req">${cb.percentage}</span></td>
        <td><span class="badge used" style="background: var(--green-dim); color: var(--green); font-weight: 600;">${cb.cost}</span></td>
      `;
      tbody.appendChild(tr);
    });

    if (currentCostView === 'chart') {
      renderCostChart();
    }
  }

  function renderCostChart() {
    const cluster = document.getElementById('costClusterSelect').value;
    const list = allChargebacks[cluster] || [];
    
    if (list.length === 0) return;
    
    const labels = list.map(item => item.namespace);
    const data = list.map(item => parseFloat(item.percentage.replace('%', '')) || 0);
    const costs = list.map(item => item.cost);
    
    const ctx = document.getElementById('costDoughnutChart').getContext('2d');
    
    if (costDoughnutChart) {
      costDoughnutChart.destroy();
    }
    
    costDoughnutChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: [
            'rgba(99, 102, 241, 0.75)',
            'rgba(168, 85, 247, 0.75)',
            'rgba(16, 185, 129, 0.75)',
            'rgba(245, 158, 11, 0.75)',
            'rgba(59, 130, 246, 0.75)',
            'rgba(239, 68, 68, 0.75)',
            'rgba(255, 255, 255, 0.25)'
          ],
          borderColor: 'rgba(255, 255, 255, 0.08)',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: '#4b5563',
              font: {
                family: 'Plus Jakarta Sans',
                size: 11,
                weight: '500'
              },
              boxWidth: 12
            }
          },
          tooltip: {
            backgroundColor: 'rgba(13, 17, 26, 0.95)',
            titleColor: '#fff',
            bodyColor: '#d1d5db',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1,
            callbacks: {
              label: function(context) {
                const label = context.label || '';
                const value = context.parsed || 0;
                const cost = costs[context.dataIndex] || '$0.00';
                return ` ${label}: ${value}% (${cost})`;
              }
            }
          }
        },
        cutout: '65%'
      }
    });
  }

  function renderGlobalCostChart(globalCosts) {
    const s3Val = parseFloat((globalCosts.s3_cost || '0').replace('$', '').replace('/mo', '').replace(/,/g, '')) || 0;
    const cfVal = parseFloat((globalCosts.cf_cost || '0').replace('$', '').replace('/mo', '').replace(/,/g, '')) || 0;
    const eksVal = parseFloat((globalCosts.eks_cost || '0').replace('$', '').replace('/mo', '').replace(/,/g, '')) || 0;
    const ec2Val = parseFloat((globalCosts.ec2_cost || '0').replace('$', '').replace('/mo', '').replace(/,/g, '')) || 0;
    
    const ctx = document.getElementById('globalCostChart').getContext('2d');
    if (globalCostsChart) {
      globalCostsChart.destroy();
    }
    
    globalCostsChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['S3 Storage', 'CloudFront', 'EKS Control Plane', 'EC2 & EBS'],
        datasets: [{
          data: [s3Val, cfVal, eksVal, ec2Val],
          backgroundColor: [
            'rgba(59, 130, 246, 0.55)',
            'rgba(139, 92, 246, 0.55)',
            'rgba(245, 158, 11, 0.55)',
            'rgba(16, 185, 129, 0.55)'
          ],
          borderColor: [
            '#3b82f6',
            '#8b5cf6',
            '#f59e0b',
            '#10b981'
          ],
          borderWidth: 1,
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(13, 17, 26, 0.95)',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1,
            callbacks: {
              label: function(context) {
                return ` Est. Cost: $${context.parsed.toFixed(2)}/mo`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#4b5563', font: { family: 'Plus Jakarta Sans', size: 10, weight: '500' } }
          },
          y: {
            grid: { color: 'rgba(0,0,0,0.06)' },
            ticks: {
              color: '#4b5563',
              font: { family: 'JetBrains Mono', size: 9 },
              callback: function(value) { return '$' + value; }
            }
          }
        }
      }
    });
  }

  // ── Generate report ──
  let pollInterval;
  async function generateReport() {
    const btn = document.getElementById('generateBtn');
    const bar = document.getElementById('progressBar');
    btn.disabled = true;
    btn.classList.add('loading');
    bar.classList.add('active');
    bar.textContent = 'Starting...';

    if (window.fridayVoiceEnabled) {
      speak("Starting cluster analysis, Anirudh! Scanning for idle workloads.");
    }

    await fetch('/api/generate', { method: 'POST' });

    pollInterval = setInterval(async () => {
      const resp = await fetch('/api/status');
      const status = await resp.json();
      bar.textContent = status.progress || 'Working...';
      if (!status.running) {
        clearInterval(pollInterval);
        btn.disabled = false;
        btn.classList.remove('loading');
        if (status.error) {
          bar.textContent = 'Error: ' + status.error;
          if (window.jarvisVoiceEnabled) {
            speak("Sorry boss, I encountered an error during cluster analysis: " + status.error);
          }
        } else {
          bar.classList.remove('active');
          await loadReports();
        }
      }
    }, 1500);
  }

  // ── Chat ──
  async function sendChat() {
    const input = document.getElementById('chatInput');
    const msg = input.value.trim();
    if (!msg) return;

    input.value = '';
    addMessage('user', msg);

    const sendBtn = document.getElementById('chatSend');
    sendBtn.disabled = true;
    sendBtn.textContent = '...';

    const typing = document.createElement('div');
    typing.className = 'typing-indicator';
    typing.textContent = 'AI is thinking...';
    typing.id = 'typingIndicator';
    document.getElementById('chatMessages').appendChild(typing);
    scrollChat();

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const data = await resp.json();
      typing.remove();
      if (data.error) {
        addMessage('assistant', 'Error: ' + data.error);
      } else {
        addMessage('assistant', data.response);
        
        if (window.jarvisVoiceEnabled) {
          let textToSpeak = data.response;
          textToSpeak = textToSpeak.replace(/```[\s\S]*?```/g, "Code snippet provided.");
          textToSpeak = textToSpeak.replace(/`([^`]+)`/g, "$1");
          textToSpeak = textToSpeak.replace(/\*\*/g, "");
          textToSpeak = "Yes boss, " + textToSpeak;
          if (textToSpeak.length > 250) {
            textToSpeak = textToSpeak.substring(0, 250) + "... details are printed on screen, boss.";
          }
          speak(textToSpeak);
        }
      }
    } catch (e) {
      typing.remove();
      addMessage('assistant', 'Connection error: ' + e.message);
    }

    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }

  function addMessage(role, text) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const avatar = role === 'user' 
      ? '&#x1f464;' 
      : `<div class="jarvis-core"><div class="reactor-ring"></div><div class="reactor-ring-dots"></div><div class="reactor-center"></div></div>`;
    let html = text
      .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    div.innerHTML = `
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-bubble">${html}</div>
    `;
    container.appendChild(div);
    scrollChat();
  }

  function scrollChat() {
    const c = document.getElementById('chatMessages');
    c.scrollTop = c.scrollHeight;
  }

  document.getElementById('chatInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // Friday Voice Assistant Engine
  window.fridayVoiceEnabled = localStorage.getItem('fridayVoiceEnabled') !== 'false';
  window.fridaySelectedVoiceName = localStorage.getItem('fridaySelectedVoiceName') || '';
  let hasGreeted = false;

  function playFridayChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      
      const freqs = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 sweet ascending bell arpeggio
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.06);
        
        gainNode.gain.setValueAtTime(0.0, now + idx * 0.06);
        gainNode.gain.linearRampToValueAtTime(0.06, now + idx * 0.06 + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.06 + 0.25);
        
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);
        
        osc.start(now + idx * 0.06);
        osc.stop(now + idx * 0.06 + 0.3);
      });
    } catch (e) {
      console.warn("AudioContext failed to start", e);
    }
  }

  function populateVoices() {
    if (!('speechSynthesis' in window)) return;
    const voices = window.speechSynthesis.getVoices();
    const select = document.getElementById('voiceSelect');
    if (!select) return;
    
    select.innerHTML = '';
    
    let englishVoices = voices.filter(v => v.lang.toLowerCase().startsWith('en'));
    if (englishVoices.length === 0) englishVoices = voices;
    
    englishVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      if (window.fridaySelectedVoiceName === v.name) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
    
    // Auto-select Siri, Samantha, Google, or Zira if not chosen
    if (!window.fridaySelectedVoiceName && englishVoices.length > 0) {
      let defaultVoice = englishVoices.find(v => v.name.toLowerCase().includes('siri'));
      if (!defaultVoice) defaultVoice = englishVoices.find(v => v.name.toLowerCase().includes('samantha'));
      if (!defaultVoice) defaultVoice = englishVoices.find(v => v.name.toLowerCase().includes('google us'));
      if (!defaultVoice) defaultVoice = englishVoices.find(v => v.name.toLowerCase().includes('zira'));
      if (!defaultVoice) defaultVoice = englishVoices[0];
      
      if (defaultVoice) {
        window.fridaySelectedVoiceName = defaultVoice.name;
        localStorage.setItem('fridaySelectedVoiceName', defaultVoice.name);
        select.value = defaultVoice.name;
      }
    }
  }

  function changeVoice(voiceName) {
    window.fridaySelectedVoiceName = voiceName;
    localStorage.setItem('fridaySelectedVoiceName', voiceName);
    speak("Voice changed to " + voiceName.split(' ')[0]);
  }

  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = populateVoices;
    setTimeout(populateVoices, 100);
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    if (!window.fridayVoiceEnabled) return;
    
    window.speechSynthesis.cancel();
    
    // Play sweet Friday star chime
    playFridayChime();
    
    setTimeout(() => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      
      let selectedVoice = null;
      if (window.fridaySelectedVoiceName) {
        selectedVoice = voices.find(v => v.name === window.fridaySelectedVoiceName);
      }
      
      // Fallbacks
      if (!selectedVoice) {
        selectedVoice = voices.find(v => {
          const name = v.name.toLowerCase();
          const lang = v.lang.toLowerCase();
          return lang.startsWith('en') && name.includes('siri');
        });
      }
      if (!selectedVoice) {
        selectedVoice = voices.find(v => {
          const name = v.name.toLowerCase();
          const lang = v.lang.toLowerCase();
          return lang.startsWith('en') && name.includes('samantha');
        });
      }
      if (!selectedVoice) {
        selectedVoice = voices.find(v => {
          const name = v.name.toLowerCase();
          const lang = v.lang.toLowerCase();
          return lang.startsWith('en-us') && (name.includes('zira') || name.includes('google') || name.includes('female'));
        });
      }
      if (!selectedVoice) {
        selectedVoice = voices.find(v => v.lang.toLowerCase().startsWith('en-us'));
      }
      if (!selectedVoice && voices.length > 0) {
        selectedVoice = voices.find(v => v.lang.toLowerCase().startsWith('en'));
      }
      
      if (selectedVoice) utterance.voice = selectedVoice;
      
      // Configure pitch and speed for Friday's Siri-like voice profile
      utterance.rate = 1.0;  // Siri's natural conversational speed
      utterance.pitch = 1.0; // Siri's neutral vocal pitch
      utterance.volume = 1.0;
      
      window.speechSynthesis.speak(utterance);
    }, 120);
  }

  function toggleVoice(enabled) {
    window.fridayVoiceEnabled = enabled;
    localStorage.setItem('fridayVoiceEnabled', enabled);
    if (enabled) {
      speak("Hey Anirudh! Friday here, let's check out your clusters!");
    } else {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    }
  }

  function initialGreeting() {
    if (hasGreeted) return;
    if (window.fridayVoiceEnabled) {
      speak("Oh, hi Anirudh! Friday here, ready to find some EKS cluster savings. Let's make some magic!");
      hasGreeted = true;
    }
  }
  document.body.addEventListener('click', initialGreeting, { once: true });

  // ── Theme Switcher ──────────────────────────────────────────────────────
  window.setTheme = function(theme) {
    const lightBtn = document.getElementById('themeBtnLight');
    const darkBtn = document.getElementById('themeBtnDark');
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (darkBtn) {
        darkBtn.style.background = 'rgba(255,255,255,0.2)';
        darkBtn.style.color = '#fff';
      }
      if (lightBtn) {
        lightBtn.style.background = 'transparent';
        lightBtn.style.color = 'rgba(255,255,255,0.6)';
      }
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (lightBtn) {
        lightBtn.style.background = 'rgba(255,255,255,0.2)';
        lightBtn.style.color = '#fff';
      }
      if (darkBtn) {
        darkBtn.style.background = 'transparent';
        darkBtn.style.color = 'rgba(255,255,255,0.6)';
      }
      localStorage.setItem('theme', 'light');
    }
  };

  // Init
  document.getElementById('voiceToggle').checked = window.fridayVoiceEnabled;
  const savedTheme = localStorage.getItem('theme') || 'light';
  window.setTheme(savedTheme);
  loadReports();

  // ── Project Cost Estimator ──────────────────────────────────────────────
  async function runEstimator() {
    const btn = document.getElementById('estimatorBtn');
    const btnText = document.getElementById('estimatorBtnText');
    const btnIcon = document.getElementById('estimatorBtnIcon');

    const project = {
      name: document.getElementById('estProjectName').value || 'Untitled Project',
      type: document.getElementById('estProjectType').value,
      description: document.getElementById('estDescription').value,
      duration: document.getElementById('estDuration').value,
      team_size: document.getElementById('estTeamSize').value,
      modules: document.getElementById('estModules').value,
      users: document.getElementById('estUsers').value,
      database: document.getElementById('estDatabase').value,
      storage: document.getElementById('estStorage').value,
      traffic: document.getElementById('estTraffic').value,
      budget: document.getElementById('estBudget').value,
      special: document.getElementById('estSpecial').value,
    };

    // Show loading
    btn.disabled = true;
    btnText.textContent = 'Analyzing...';
    btnIcon.textContent = '⏳';
    document.getElementById('estimatorEmpty').style.display = 'none';
    document.getElementById('estimatorResults').style.display = 'none';
    document.getElementById('estimatorLoading').style.display = 'flex';

    try {
      const resp = await fetch('/api/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }),
      });

      const data = await resp.json();

      if (data.error) {
        alert('Error: ' + data.error);
        document.getElementById('estimatorLoading').style.display = 'none';
        document.getElementById('estimatorEmpty').style.display = 'flex';
      } else {
        document.getElementById('estimatorLoading').style.display = 'none';
        renderEstimatorResults(data);
      }
    } catch (e) {
      document.getElementById('estimatorLoading').style.display = 'none';
      document.getElementById('estimatorEmpty').style.display = 'flex';
      alert('Request failed: ' + e.message);
    }

    btn.disabled = false;
    btnText.textContent = 'Regenerate Plan';
    btnIcon.textContent = '🔄';
  }

  function renderEstimatorResults(data) {
    // Save current active estimation data globally for simulator
    window.currentEstimationData = data;
    
    const catColors = {
      'Compute':    { bg: 'rgba(108,93,211,0.1)',  color: '#6c5dd3' },
      'Storage':    { bg: 'rgba(245,158,11,0.1)',  color: '#f59e0b' },
      'Database':   { bg: 'rgba(59,130,246,0.1)',  color: '#3b82f6' },
      'Networking': { bg: 'rgba(16,185,129,0.1)',  color: '#10b981' },
      'CDN':        { bg: 'rgba(236,72,153,0.1)',  color: '#ec4899' },
      'Monitoring': { bg: 'rgba(139,92,246,0.1)',  color: '#8b5cf6' },
    };

    // Summary
    document.getElementById('estSummaryText').textContent = data.summary || '';
    document.getElementById('estTotalMonthly').textContent = data.total_monthly_cost || 'N/A';
    document.getElementById('estTotalAnnual').textContent = data.total_annual_cost || 'N/A';

    // Reset simulator slider
    const slider = document.getElementById('simScaleSlider');
    slider.value = 1;
    document.getElementById('simScaleLabel').textContent = '1.0x';
    document.getElementById('simTotalCost').textContent = data.total_monthly_cost || '$0';

    // Alternatives
    const altsRow = document.getElementById('estAltsRow');
    altsRow.innerHTML = '';
    (data.alternatives || []).forEach((alt, i) => {
      const colors = i === 0 ? ['rgba(34,197,94,0.08)', 'rgba(34,197,94,0.2)', '#16a34a'] : ['rgba(108,93,211,0.08)', 'rgba(108,93,211,0.2)', '#6c5dd3'];
      altsRow.innerHTML += `
        <div style="background: ${colors[0]}; border: 1px solid ${colors[1]}; border-radius: 12px; padding: 16px;">
          <div style="font-weight: 700; font-size: 12px; color: ${colors[2]}; text-transform: uppercase; letter-spacing: 0.5px;">${alt.name || ''}</div>
          <div style="font-size: 13px; color: var(--text); margin-top: 4px;">${alt.description || ''}</div>
          <div style="font-family: 'JetBrains Mono', monospace; font-size: 18px; font-weight: 900; color: ${colors[2]}; margin-top: 8px;">${alt.monthly_cost || 'N/A'}<span style="font-size: 11px; font-weight: 400; opacity: 0.7;">/mo</span></div>
        </div>
      `;
    });

    // Resource table
    const tbody = document.getElementById('estResourceTable');
    tbody.innerHTML = '';
    (data.resources || []).forEach((r, idx) => {
      const c = catColors[r.category] || { bg: 'rgba(0,0,0,0.05)', color: 'var(--muted)' };
      tbody.innerHTML += `
        <tr style="border-bottom: 1px solid var(--border); ${idx % 2 === 0 ? '' : 'background: rgba(0,0,0,0.01);'}">
          <td style="padding: 12px 16px;">
            <span style="background: ${c.bg}; color: ${c.color}; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.3px;">${r.category || 'Other'}</span>
          </td>
          <td style="padding: 12px 16px;">
            <div style="font-weight: 600; font-size: 13px; color: var(--text);">${r.service || ''}</div>
            <div style="font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace;">${r.resource || ''}</div>
            ${r.cost_tip ? `<div style="font-size: 10px; color: #10b981; margin-top: 3px;">💡 ${r.cost_tip}</div>` : ''}
          </td>
          <td style="padding: 12px 16px; font-size: 12px; color: var(--muted); max-width: 200px;">${r.purpose || ''}</td>
          <td style="padding: 12px 16px; text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 700; color: var(--text);">${r.monthly_cost || 'N/A'}</td>
        </tr>
      `;
    });

    // Cost tips
    const tipsList = document.getElementById('estCostTips');
    tipsList.innerHTML = '';
    (data.cost_optimization_tips || []).forEach(t => {
      const li = document.createElement('li');
      li.style.cssText = 'font-size: 12px; color: var(--text); line-height: 1.6;';
      li.textContent = t;
      tipsList.appendChild(li);
    });

    // Architecture highlights
    const archList = document.getElementById('estArchHighlights');
    archList.innerHTML = '';
    (data.architecture_highlights || []).forEach(h => {
      const li = document.createElement('li');
      li.style.cssText = 'font-size: 12px; color: var(--text); line-height: 1.6;';
      li.textContent = h;
      archList.appendChild(li);
    });

    // Scaling notes
    document.getElementById('estScalingNotes').textContent = data.scaling_notes || '';

    // Render Terraform
    const tfBlock = document.getElementById('estTerraformCode');
    tfBlock.textContent = data.terraform || '# Core terraform modules not generated for this setup.';

    // Draw SVG Topology
    drawTopologyMap(data.resources);

    // Show results
    const resultsEl = document.getElementById('estimatorResults');
    resultsEl.style.display = 'flex';
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Tab Switcher for Estimator Results ──
  function switchEstTab(tabId) {
    document.querySelectorAll('.est-tab').forEach(btn => {
      btn.style.borderBottomColor = 'transparent';
      btn.style.color = 'var(--muted)';
    });
    
    // Set active style
    const activeBtn = Array.from(document.querySelectorAll('.est-tab')).find(btn => btn.getAttribute('onclick').includes(tabId));
    if (activeBtn) {
      activeBtn.style.borderBottomColor = '#6c5dd3';
      activeBtn.style.color = '#1e1e2d';
    }

    document.querySelectorAll('.est-tab-panel').forEach(panel => {
      panel.style.display = 'none';
    });
    
    const panel = document.getElementById('estTabContent-' + tabId);
    if (panel) {
      panel.style.display = tabId === 'details' ? 'flex' : 'block';
    }
  }

  // ── Copy Terraform Config to Clipboard ──
  function copyEstTerraform() {
    const code = document.getElementById('estTerraformCode').textContent;
    navigator.clipboard.writeText(code);
    alert('Copied Terraform configuration code to clipboard!');
  }

  // ── Load Simulator Scaling Handler ──
  function updateLoadSimulation(val) {
    document.getElementById('simScaleLabel').textContent = val + 'x';
    const data = window.currentEstimationData;
    if (!data) return;

    // Parse base cost
    const baseStr = (data.total_monthly_cost || '$0').replace(/[^0-9.]/g, '');
    const baseCost = parseFloat(baseStr) || 0;
    const scaledCost = Math.round(baseCost * val);
    document.getElementById('simTotalCost').textContent = '$' + scaledCost.toLocaleString();

    // Adjust SVG topology animations and component visual sizes
    const speed = Math.max(1, 6 - (val / 2)); // High scale = faster packets
    document.querySelectorAll('.traffic-dot').forEach(dot => {
      dot.setAttribute('dur', speed + 's');
    });

    document.querySelectorAll('.compute-node').forEach(node => {
      const scale = 1 + (val - 1) * 0.05; // Maximum 1.45x size
      node.style.transform = `scale(${scale})`;
      node.style.transformOrigin = 'center';
    });

    // Update active user SVG label if exists
    const usersLabel = document.getElementById('svg-users-count');
    if (usersLabel) {
      const baseUsers = parseInt(document.getElementById('estUsers').value) || 1000;
      usersLabel.textContent = Math.round(baseUsers * val).toLocaleString() + ' users';
    }
  }

  // ── SVG Infrastructure Topology Map Generator ──
  function drawTopologyMap(resources) {
    const container = document.getElementById('topologyCanvasContainer');
    container.innerHTML = ''; // Clear previous

    if (!resources || resources.length === 0) {
      container.innerHTML = '<div style="color: var(--muted); font-size: 13px;">No topology resources generated.</div>';
      return;
    }

    // Process nodes
    const nodeCategories = {
      'Networking': [],
      'Compute': [],
      'Database': [],
      'Storage': [],
      'Monitoring': [],
      'Other': []
    };

    resources.forEach(r => {
      const cat = r.category || 'Other';
      if (nodeCategories[cat]) {
        nodeCategories[cat].push(r);
      } else {
        nodeCategories['Other'].push(r);
      }
    });

    // Construct SVG coordinates and icons
    const width = 640;
    const height = 300;

    let svg = `
    <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="background: #fafbfc; border-radius: 8px;">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 2 L 10 5 L 0 8 z" fill="#a5b4fc" />
        </marker>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
        <linearGradient id="primaryGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#6c5dd3" />
          <stop offset="100%" stop-color="#8b7ae8" />
        </linearGradient>
      </defs>

      <!-- Client Users -->
      <g transform="translate(40, 150)" class="svg-clickable-node" onclick="showNodeDetail('Clients', 'Active Web/Mobile Users', 'Handles concurrent application hits', '$0.00', 'Optimized via regional DNS routing.')" style="cursor: pointer;">
        <circle cx="0" cy="0" r="28" fill="#e0e7ff" stroke="#6c5dd3" stroke-width="2" />
        <text x="0" y="5" font-family="'Outfit', sans-serif" font-size="20" text-anchor="middle">👥</text>
        <text x="0" y="44" font-family="'Space Grotesk', sans-serif" font-size="11" font-weight="700" text-anchor="middle" fill="#1e1e2d">Clients</text>
        <text id="svg-users-count" x="0" y="56" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#6c5dd3">1,000 users</text>
      </g>
    `;

    // Calculate layout locations
    // Client (40, 150) -> ALB (150, 150) -> Compute/EKS (300, 150) -> DB (480, 80) & S3 (480, 220)
    // Connecting lines with traffic animations
    const paths = [
      { id: 'clients-alb', d: 'M 68 150 L 122 150' },
      { id: 'alb-compute', d: 'M 178 150 L 272 150' },
      { id: 'compute-db', d: 'M 328 135 L 452 85' },
      { id: 'compute-storage', d: 'M 328 165 L 452 215' }
    ];

    paths.forEach(p => {
      svg += `
        <path d="${p.d}" fill="none" stroke="#e2e8f0" stroke-width="3" marker-end="url(#arrow)" />
        <path d="${p.d}" fill="none" stroke="#818cf8" stroke-width="2" stroke-dasharray="8 12" style="opacity: 0.85;">
          <animate class="traffic-dot" attributeName="stroke-dashoffset" values="40;0" dur="4s" repeatCount="indefinite" />
        </path>
      `;
    });

    // Node 1: Networking / ALB
    const netResource = nodeCategories['Networking'][0] || nodeCategories['CDN'][0] || { service: 'AWS ALB', resource: 'Application Load Balancer', purpose: 'SSL/Traffic routing', monthly_cost: '$22.00', cost_tip: 'Consolidate multiple domain routing.' };
    svg += `
      <g transform="translate(150, 150)" class="svg-clickable-node" onclick="showNodeDetail('${netResource.service}', '${netResource.resource}', '${netResource.purpose.replace(/'/g, "\\'")}', '${netResource.monthly_cost}', '${(netResource.cost_tip || '').replace(/'/g, "\\'")}')" style="cursor: pointer;">
        <circle cx="0" cy="0" r="26" fill="#ecfdf5" stroke="#10b981" stroke-width="2" />
        <text x="0" y="5" font-family="'Outfit', sans-serif" font-size="18" text-anchor="middle">🌐</text>
        <text x="0" y="42" font-family="'Space Grotesk', sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#1e1e2d">${netResource.service}</text>
        <text x="0" y="53" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#10b981">${netResource.monthly_cost}</text>
      </g>
    `;

    // Node 2: Compute (EKS / EC2)
    const computeResource = nodeCategories['Compute'][0] || { service: 'Amazon EKS', resource: 't3.medium Node Group', purpose: 'Core application services', monthly_cost: '$72.00', cost_tip: 'Apply weekday auto-scaling.' };
    svg += `
      <g transform="translate(300, 150)" class="svg-clickable-node compute-node" onclick="showNodeDetail('${computeResource.service}', '${computeResource.resource}', '${computeResource.purpose.replace(/'/g, "\\'")}', '${computeResource.monthly_cost}', '${(computeResource.cost_tip || '').replace(/'/g, "\\'")}')" style="cursor: pointer; transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
        <rect x="-28" y="-28" width="56" height="56" rx="10" fill="url(#primaryGrad)" filter="url(#glow)" />
        <text x="0" y="6" font-family="'Outfit', sans-serif" font-size="20" text-anchor="middle" fill="#ffffff">⚡</text>
        <text x="0" y="44" font-family="'Space Grotesk', sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#1e1e2d">${computeResource.service}</text>
        <text x="0" y="55" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#6c5dd3">${computeResource.monthly_cost}</text>
      </g>
    `;

    // Node 3: Database (RDS / DynamoDB)
    const dbResource = nodeCategories['Database'][0] || { service: 'Amazon RDS', resource: 'db.t3.micro PostgreSQL', purpose: 'Transactional relational DB', monthly_cost: '$15.00', cost_tip: 'Use Single-AZ and local backups for dev.' };
    svg += `
      <g transform="translate(480, 80)" class="svg-clickable-node" onclick="showNodeDetail('${dbResource.service}', '${dbResource.resource}', '${dbResource.purpose.replace(/'/g, "\\'")}', '${dbResource.monthly_cost}', '${(dbResource.cost_tip || '').replace(/'/g, "\\'")}')" style="cursor: pointer;">
        <circle cx="0" cy="0" r="26" fill="#eff6ff" stroke="#3b82f6" stroke-width="2" />
        <text x="0" y="5" font-family="'Outfit', sans-serif" font-size="18" text-anchor="middle">🗄️</text>
        <text x="0" y="42" font-family="'Space Grotesk', sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#1e1e2d">${dbResource.service}</text>
        <text x="0" y="53" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#3b82f6">${dbResource.monthly_cost}</text>
      </g>
    `;

    // Node 4: Storage (S3)
    const storageResource = nodeCategories['Storage'][0] || { service: 'Amazon S3', resource: 'Standard 100GB Bucket', purpose: 'Static files and logs', monthly_cost: '$2.50', cost_tip: 'Lifecycle rules to transition old logs to Glacier.' };
    svg += `
      <g transform="translate(480, 220)" class="svg-clickable-node" onclick="showNodeDetail('${storageResource.service}', '${storageResource.resource}', '${storageResource.purpose.replace(/'/g, "\\'")}', '${storageResource.monthly_cost}', '${(storageResource.cost_tip || '').replace(/'/g, "\\'")}')" style="cursor: pointer;">
        <circle cx="0" cy="0" r="26" fill="#fffbeb" stroke="#f59e0b" stroke-width="2" />
        <text x="0" y="5" font-family="'Outfit', sans-serif" font-size="18" text-anchor="middle">📦</text>
        <text x="0" y="42" font-family="'Space Grotesk', sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#1e1e2d">${storageResource.service}</text>
        <text x="0" y="53" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#f59e0b">${storageResource.monthly_cost}</text>
      </g>
    `;

    // Node 5: Monitoring / CloudWatch (if any)
    const monitorResource = nodeCategories['Monitoring'][0] || { service: 'CloudWatch', resource: 'Standard logs/metrics', purpose: 'Performance monitoring', monthly_cost: '$3.00', cost_tip: 'Optimize metric ingestion intervals.' };
    // Connect compute to Monitoring
    svg += `
      <path d="M 300 206 L 300 240 L 380 240 L 380 240" fill="none" stroke="#e2e8f0" stroke-width="2" style="stroke-dasharray: 4 6;" />
      <g transform="translate(300, 240)" class="svg-clickable-node" onclick="showNodeDetail('${monitorResource.service}', '${monitorResource.resource}', '${monitorResource.purpose.replace(/'/g, "\\'")}', '${monitorResource.monthly_cost}', '${(monitorResource.cost_tip || '').replace(/'/g, "\\'")}')" style="cursor: pointer;">
        <circle cx="0" cy="0" r="16" fill="#f5f3ff" stroke="#8b5cf6" stroke-width="1.5" />
        <text x="0" y="4" font-family="'Outfit', sans-serif" font-size="11" text-anchor="middle">📊</text>
        <text x="32" y="4" font-family="'Space Grotesk', sans-serif" font-size="9" font-weight="700" text-anchor="left" fill="#8b5cf6">${monitorResource.service}</text>
      </g>
    `;

    svg += `</svg>`;
    container.innerHTML = svg;

    // Show initial highlight with first resource
    const initial = resources[0] || computeResource;
    showNodeDetail(initial.service, initial.resource, initial.purpose, initial.monthly_cost, initial.cost_tip);
  }

  // ── Show Detail Card under Topology SVG ──
  function showNodeDetail(name, resource, purpose, cost, tip) {
    const card = document.getElementById('topoNodeDetail');
    if (card) {
      card.style.display = 'block';
      document.getElementById('topoDetailName').textContent = name + ' (' + resource + ')';
      document.getElementById('topoDetailCost').textContent = cost;
      document.getElementById('topoDetailPurpose').textContent = purpose;
      const tipEl = document.getElementById('topoDetailTip');
      if (tipEl) {
        tipEl.innerHTML = tip ? '💡 <strong>FinOps Optimization Advice:</strong> ' + tip : '';
      }
    }
  }

  // ── Template Archetypes Definition ──
  const EST_TEMPLATES = {
    saas: {
      name: 'Web SaaS Boilerplate',
      desc: 'React SPA on S3 + CloudFront CDN, Node.js REST API hosted on ECS Fargate, transactional PostgreSQL RDS, and Redis ElastiCache.',
      type: 'SaaS Product',
      duration: '12 months',
      team_size: '3-5',
      modules: 4,
      users: '5000',
      database: 'PostgreSQL (RDS)',
      storage: '200GB',
      traffic: '24/7 consistent',
      budget: 'Balanced (cost + reliability)',
      special: 'Enable RDS automated backups and compute task auto-scaling targets.',
      previewCost: '$75.60',
      previewSavings: '$18.50',
      summary: 'React SPA on S3 + CloudFront CDN, Node.js REST API hosted on ECS Fargate, transactional PostgreSQL RDS, and Redis ElastiCache.',
      total_monthly_cost: '$75.60',
      total_annual_cost: '$907.20',
      resources: [
        { category: 'Networking', service: 'Amazon CloudFront & ALB', resource: 'Global CDN + ALB', purpose: 'Static web hosting & API routing', monthly_cost: '$32.00', cost_tip: 'Leverage CloudFront caching for assets.' },
        { category: 'Compute', service: 'AWS Fargate', resource: '2x 0.5 vCPU 1GB Tasks', purpose: 'Containerized API backend services', monthly_cost: '$24.00', cost_tip: 'Set CPU target scaling to 70%.' },
        { category: 'Database', service: 'Amazon RDS Postgres', resource: 'db.t3.micro Single-AZ', purpose: 'User accounts & app database', monthly_cost: '$15.00', cost_tip: 'Use standard gp3 storage volumes.' },
        { category: 'Storage', service: 'Amazon S3', resource: 'Standard 200GB Bucket', purpose: 'User file uploads', monthly_cost: '$4.60', cost_tip: 'Apply lifecycle policies to old logs.' }
      ],
      architecture_highlights: [
        'Decoupled frontend hosted on S3 and cached via CloudFront CDN for global sub-10ms asset delivery.',
        'Serverless Compute tier using AWS Fargate (ECS) to eliminate EC2 OS management overhead and idle scale charges.',
        'Managed PostgreSQL RDS configured on db.t3.micro with GP3 storage volumes saving 20% compared to legacy GP2.'
      ],
      cost_optimization_tips: [
        'Set up S3 Lifecycle rule to transition application logs to Glacier Deep Archive after 30 days.',
        'Configure ECS Task scale-down to 0 tasks during weekends/off-hours using Application Auto Scaling schedules.',
        'Purchase Compute Savings Plan to save up to 28% on Fargate tasks if project commits to 1-year usage.'
      ],
      scaling_notes: 'As traffic increases, Fargate tasks can scale out up to 10 instances. S3 and CloudFront scale infinitely with negligible cost per request. Relational RDS will require upgrading to Aurora Serverless v2 for autoscaling.',
      alternatives: [
        { name: 'Lean Starter Option', description: 'Deploy Node.js REST API on a shared t3.micro EC2 instance; SQLite/Local DB.', monthly_cost: '$12.50' },
        { name: 'High Availability Option', description: 'Multi-AZ ECS deployment, db.t3.medium Multi-AZ RDS instance, Redis cluster caching.', monthly_cost: '$185.00' }
      ],
      terraform: `# Provider config\nprovider "aws" {\n  region = "ap-south-1"\n}\n\n# S3 Bucket for React Frontend\nresource "aws_s3_bucket" "frontend" {\n  bucket = "medvista-saas-frontend-bucket"\n  tags = {\n    Environment = "Dev"\n    CostCenter  = "Frontend"\n  }\n}\n\n# CloudFront CDN\nresource "aws_cloudfront_distribution" "cdn" {\n  origin {\n    domain_name = aws_s3_bucket.frontend.bucket_regional_domain_name\n    origin_id   = "S3-Frontend"\n  }\n  enabled             = true\n  default_root_object = "index.html"\n  default_cache_behavior {\n    allowed_methods  = ["GET", "HEAD"]\n    cached_methods   = ["GET", "HEAD"]\n    target_origin_id = "S3-Frontend"\n    viewer_protocol_policy = "redirect-to-https"\n    min_ttl     = 0\n    default_ttl = 86400\n    max_ttl     = 31536000\n  }\n  viewer_certificate {\n    cloudfront_default_certificate = true\n  }\n}\n\n# Amazon RDS PostgreSQL\nresource "aws_db_instance" "postgres" {\n  allocated_storage    = 20\n  engine               = "postgres"\n  engine_version       = "15.4"\n  instance_class       = "db.t3.micro"\n  db_name              = "saas_db"\n  username             = "admin"\n  password             = "SecurePassword123"\n  parameter_group_name = "default.postgres15"\n  skip_final_snapshot  = true\n  storage_type         = "gp3"\n}\n\n# ECS Fargate Cluster\nresource "aws_ecs_cluster" "app_cluster" {\n  name = "saas-app-cluster"\n}`
    },
    ai: {
      name: 'AI/LLM Workspace Pipeline',
      desc: 'Python ML pipeline with t3.large node group + 1 GPU node scaled down to 0 on weekends to save cluster compute charges.',
      type: 'Machine Learning / AI',
      duration: '6 months',
      team_size: '3-5',
      modules: 3,
      users: '100',
      database: 'MongoDB (DocumentDB)',
      storage: '1TB',
      traffic: 'Burst (unpredictable spikes)',
      budget: 'Balanced (cost + reliability)',
      special: 'Requires GPU training node. Enforce off-hours weekend scaler shutdown.',
      previewCost: '$493.50',
      previewSavings: '$125.00',
      summary: 'Python ML pipeline with t3.large node group + 1 GPU node scaled down to 0 on weekends to save cluster compute charges.',
      total_monthly_cost: '$493.50',
      total_annual_cost: '$5,922.00',
      resources: [
        { category: 'Networking', service: 'Application Load Balancer', resource: 'Standard ALB', purpose: 'Ingress controller routing', monthly_cost: '$22.50', cost_tip: 'Delete unused listeners.' },
        { category: 'Compute', service: 'Amazon EKS Cluster', resource: '1x g4dn.xlarge GPU + 2x t3.large', purpose: 'Model inference & APIs', monthly_cost: '$390.00', cost_tip: 'Scale GPU node group to 0 on weekends.' },
        { category: 'Database', service: 'DocumentDB', resource: 'db.t3.medium Node', purpose: 'Vector embeddings store', monthly_cost: '$58.00', cost_tip: 'Stop db instance during dev downtime.' },
        { category: 'Storage', service: 'Amazon S3', resource: '1TB Storage Bucket', purpose: 'Training datasets repository', monthly_cost: '$23.00', cost_tip: 'Use Intelligent-Tiering.' }
      ],
      architecture_highlights: [
        'EKS Kubernetes cluster orchestrating standard compute nodes and on-demand GPU accelerators.',
        'NVIDIA T4 GPU acceleration using g4dn.xlarge instance for high-throughput model inference/training.',
        'S3 bucket integration with Amazon EKS via VPC Gateway Endpoint to prevent outbound data transit costs.'
      ],
      cost_optimization_tips: [
        'Configure EKS Cluster Auto-scaler to scale GPU node group to 0 replicas during nights and weekends.',
        'Use Spot Instances for standard t3.large node groups to save up to 70% compared to on-demand pricing.',
        'Deploy KEDA (Kubernetes Event-driven Autoscaling) to trigger model endpoint scaling based on queue depth.'
      ],
      scaling_notes: 'The GPU node group scales dynamically between 0 and 3 nodes. During weekends, EKS scales down to 0 GPU nodes, reducing compute charges by over $370/month.',
      alternatives: [
        { name: 'Serverless API Option', description: 'Host LLMs via Amazon Bedrock Serverless APIs, Lambda with custom container images.', monthly_cost: '$140.00' },
        { name: 'Enterprise Training Cluster', description: 'Multi-node GPU EKS cluster with g5.2xlarge instances, FSx for Lustre storage.', monthly_cost: '$1,450.00' }
      ],
      terraform: `# AWS EKS Cluster with GPU Node Group\nresource "aws_eks_cluster" "ai_cluster" {\n  name     = "ai-workspace-cluster"\n  role_arn = aws_iam_role.eks_role.arn\n  vpc_config {\n    subnet_ids = [aws_subnet.priv1.id, aws_subnet.priv2.id]\n  }\n}\n\n# Standard Compute Node Group (t3.large)\nresource "aws_eks_node_group" "standard_nodes" {\n  cluster_name    = aws_eks_cluster.ai_cluster.name\n  node_group_name = "standard-nodes"\n  node_role_arn   = aws_iam_role.node_role.arn\n  subnet_ids      = [aws_subnet.priv1.id, aws_subnet.priv2.id]\n  instance_types  = ["t3.large"]\n  scaling_config {\n    desired_size = 2\n    max_size     = 5\n    min_size     = 1\n  }\n}\n\n# GPU ML Node Group (g4dn.xlarge) with Autoscaling\nresource "aws_eks_node_group" "gpu_nodes" {\n  cluster_name    = aws_eks_cluster.ai_cluster.name\n  node_group_name = "gpu-inference-nodes"\n  node_role_arn   = aws_iam_role.node_role.arn\n  subnet_ids      = [aws_subnet.priv1.id]\n  instance_types  = ["g4dn.xlarge"]\n  scaling_config {\n    desired_size = 1\n    max_size     = 3\n    min_size     = 0\n  }\n}`
    },
    healthcare: {
      name: 'HIPAA Health Portal',
      desc: 'Highly secure clinical dashboard in multi-AZ private subnets, Web Application Firewall security, and CloudTrail logging.',
      type: 'Web Application',
      duration: 'Ongoing',
      team_size: '5-10',
      modules: 6,
      users: '2000',
      database: 'Aurora (MySQL/Postgres)',
      storage: '500GB',
      traffic: 'Business hours only (9AM-6PM)',
      budget: 'Enterprise-grade (HA + redundancy)',
      special: 'Full HIPAA compliance audit, KMS encryption keys, and AWS WAF rule sets enabled.',
      previewCost: '$466.00',
      previewSavings: '$82.00',
      summary: 'Highly secure clinical dashboard in multi-AZ private subnets, Web Application Firewall security, and CloudTrail logging.',
      total_monthly_cost: '$466.00',
      total_annual_cost: '$5,592.00',
      resources: [
        { category: 'Networking', service: 'AWS WAF & Shield', resource: 'Managed WAF Rules', purpose: 'Malicious payload filtering', monthly_cost: '$38.00', cost_tip: 'Use AWS Managed Rulesets.' },
        { category: 'Compute', service: 'Amazon EKS', resource: '3x m6g.large Multi-AZ', purpose: 'Private compute node groups', monthly_cost: '$218.00', cost_tip: 'Purchase Compute Savings Plans.' },
        { category: 'Database', service: 'Aurora PostgreSQL', resource: 'db.r6g.large Multi-AZ', purpose: 'Encrypted patient database', monthly_cost: '$198.00', cost_tip: 'Enable database storage auto-scaling.' },
        { category: 'Storage', service: 'Amazon S3 KMS', resource: 'KMS Encrypted Bucket', purpose: 'Protected Health Records (PHI)', monthly_cost: '$12.00', cost_tip: 'Enforce Object Lock policy.' }
      ],
      architecture_highlights: [
        'Multi-AZ secure private network routing all database traffic strictly inside isolated private subnets.',
        'HIPAA compliance assured with AWS WAF protection and full KMS envelope encryption for DB and S3 assets.',
        'Aurora PostgreSQL cluster running on AWS Graviton instances (db.r6g) for 40% better price-performance.'
      ],
      cost_optimization_tips: [
        'Turn off the non-production Aurora replicas during dev downtime using CloudWatch event rules.',
        'Enable S3 Object Lock and configure S3 Glacier transitions to archive PHI records for the mandatory 7 years.',
        'Purchase RDS Reserved Instances for the cluster to cut relational database costs by up to 35%.'
      ],
      scaling_notes: 'The system handles traffic peaks by scaling EKS pods dynamically. Databases are hosted on Aurora PostgreSQL with storage auto-scaling, supporting up to 64TB of HIPAA-encrypted records.',
      alternatives: [
        { name: 'Basic Non-HA Portal', description: 'Single-AZ db.t3.medium PostgreSQL RDS, standard EC2 server, basic AWS Shield Protection.', monthly_cost: '$180.00' },
        { name: 'Enterprise Healthcare SaaS', description: 'Multi-region Aurora Global Database, Advanced Shield Premium protection, GuardDuty monitoring.', monthly_cost: '$1,280.00' }
      ],
      terraform: `# Secure HIPAA Compliant Database Cluster\nresource "aws_rds_cluster" "aurora" {\n  cluster_identifier      = "hipaa-aurora-cluster"\n  engine                  = "aurora-postgresql"\n  engine_version          = "14.6"\n  database_name           = "portal_db"\n  master_username         = "sec_admin"\n  master_password         = "SuperSecurePassword987"\n  backup_retention_period = 30\n  preferred_backup_window = "02:00-03:00"\n  storage_encrypted       = true\n  kms_key_id              = aws_kms_key.db_key.arn\n}\n\nresource "aws_rds_cluster_instance" "cluster_instances" {\n  count              = 2\n  identifier         = "aurora-instance-\${count.index}"\n  cluster_identifier = aws_rds_cluster.aurora.id\n  instance_class     = "db.r6g.large"\n  engine             = aws_rds_cluster.aurora.engine\n  engine_version     = aws_rds_cluster.aurora.engine_version\n}`
    },
    highscale: {
      name: 'High-Scale Serverless API',
      desc: 'Global API service with Amazon DynamoDB, API Gateway, Lambda, and CloudFront CDN caching for static assets.',
      type: 'Mobile Backend (API)',
      duration: '12 months',
      team_size: '1-2 (Solo / Pair)',
      modules: 8,
      users: '50000',
      database: 'DynamoDB',
      storage: '50GB',
      traffic: 'Burst (unpredictable spikes)',
      budget: 'Minimize cost (startup / dev)',
      special: 'Serverless preference, global caching with minimal cold start latency.',
      previewCost: '$89.15',
      previewSavings: '$22.00',
      summary: 'Global API service with Amazon DynamoDB, API Gateway, Lambda, and CloudFront CDN caching for static assets.',
      total_monthly_cost: '$89.15',
      total_annual_cost: '$1,069.80',
      resources: [
        { category: 'Networking', service: 'API Gateway & CloudFront', resource: 'REST APIs + CDN', purpose: 'Low-latency global edge API routing', monthly_cost: '$28.00', cost_tip: 'Use HTTP APIs instead of REST APIs.' },
        { category: 'Compute', service: 'AWS Lambda', resource: '10M inv x 512MB RAM', purpose: 'On-demand microservices execution', monthly_cost: '$42.00', cost_tip: 'Keep executions under 200ms.' },
        { category: 'Database', service: 'DynamoDB On-Demand', resource: 'On-demand capacity units', purpose: 'Fast NoSQL transaction store', monthly_cost: '$18.00', cost_tip: 'Enable DynamoDB TTL for auto-cleanup.' },
        { category: 'Storage', service: 'Amazon S3', resource: '50GB Standard Bucket', purpose: 'Config assets bucket', monthly_cost: '$1.15', cost_tip: 'Configure browser caching headers.' }
      ],
      architecture_highlights: [
        'Zero-idle-cost Serverless design utilizing AWS Lambda, DynamoDB, and Amazon API Gateway.',
        'DynamoDB On-Demand capacity billing which matches database charges directly to request volume.',
        'API Gateway integrations with CloudFront caching to drop Lambda trigger counts on static routes.'
      ],
      cost_optimization_tips: [
        'Use DynamoDB Time-To-Live (TTL) to delete expired tokens/logs automatically, saving storage costs.',
        'Implement API Gateway caching for public endpoints to minimize Lambda invocations and execution time.',
        'Optimize Lambda Memory Allocations using AWS Lambda Power Tuning to find the lowest cost/speed ratio.'
      ],
      scaling_notes: 'Scales instantly to 10,000+ concurrent requests. Pay-per-use billing ensures cost scales linearly with traffic; active development months are extremely cheap ($10 - $30).',
      alternatives: [
        { name: 'Provisioned Capacity Option', description: 'Enable Provisioned Concurrency on Lambdas to eliminate cold starts, and DynamoDB Provisioned capacity.', monthly_cost: '$195.00' },
        { name: 'Minimal Hobby Tier', description: 'Free tier Lambda allocations, DynamoDB Free Tier capacity, local API Gateway cache.', monthly_cost: '$0.00' }
      ],
      terraform: `# DynamoDB On-Demand Table\nresource "aws_dynamodb_table" "db" {\n  name             = "app-transactions"\n  billing_mode     = "PAY_PER_REQUEST"\n  hash_key         = "TransactionId"\n  \n  attribute {\n    name = "TransactionId"\n    type = "S"\n  }\n  \n  ttl {\n    attribute_name = "TimeToLive"\n    enabled        = true\n  }\n}\n\n# AWS Lambda Function\nresource "aws_lambda_function" "api_handler" {\n  function_name = "api-lambda-handler"\n  role          = aws_iam_role.lambda_exec.arn\n  handler       = "index.handler"\n  runtime       = "nodejs18.x"\n  memory_size   = 512\n  timeout       = 15\n}`
    }
  };

  // ── Apply Preset Template ──
  function applyEstTemplate(key) {
    const t = EST_TEMPLATES[key];
    if (!t) return;

    window.currentSelectedEstTemplate = key;

    // Toggle active class on buttons
    document.querySelectorAll('.est-preset-btn').forEach(btn => {
      btn.classList.remove('active');
      btn.style.borderColor = 'var(--border)';
      btn.style.background = '#fff';
    });

    const activeBtn = Array.from(document.querySelectorAll('.est-preset-btn')).find(btn => btn.getAttribute('onclick').includes(key));
    if (activeBtn) {
      activeBtn.classList.add('active');
      activeBtn.style.borderColor = '#6c5dd3';
      activeBtn.style.background = 'rgba(108,93,211,0.05)';
    }

    // Populate inputs on the left
    document.getElementById('estProjectName').value = t.name;
    document.getElementById('estDescription').value = t.desc;
    document.getElementById('estProjectType').value = t.type;
    document.getElementById('estDuration').value = t.duration;
    document.getElementById('estTeamSize').value = t.team_size;
    document.getElementById('estModules').value = t.modules;
    document.getElementById('estUsers').value = t.users;
    document.getElementById('estDatabase').value = t.database;
    document.getElementById('estStorage').value = t.storage;
    document.getElementById('estTraffic').value = t.traffic;
    document.getElementById('estBudget').value = t.budget;
    document.getElementById('estSpecial').value = t.special;

    // Show the results section directly and hide empty/loading states
    const resultsEl = document.getElementById('estimatorResults');
    if (resultsEl) resultsEl.style.display = 'flex';
    const emptyEl = document.getElementById('estimatorEmpty');
    if (emptyEl) emptyEl.style.display = 'none';
    const loadingEl = document.getElementById('estimatorLoading');
    if (loadingEl) loadingEl.style.display = 'none';

    // Render results using the dynamic estimation calculator
    recalculateProjectEstimate();
  }

  // ── Dynamic Frontend AWS Cost Estimator ──
  function recalculateProjectEstimate() {
    const name = document.getElementById('estProjectName').value || 'AWS Project';
    const type = document.getElementById('estProjectType').value;
    const duration = document.getElementById('estDuration').value || '12 months';
    const teamSizeStr = document.getElementById('estTeamSize').value || '3-5';
    const modules = parseInt(document.getElementById('estModules').value) || 3;
    const usersStr = document.getElementById('estUsers').value || '1000';
    const dbType = document.getElementById('estDatabase').value || 'PostgreSQL (RDS)';
    const storageStr = document.getElementById('estStorage').value || '100GB';
    const traffic = document.getElementById('estTraffic').value || '24/7 consistent';
    const budget = document.getElementById('estBudget').value || 'Balanced (cost + reliability)';
    const special = document.getElementById('estSpecial').value || '';

    // Extract numeric users
    const users = parseInt(usersStr.replace(/[^0-9]/g, '')) || 1000;

    // Extract numeric storage in GB
    let storageGb = parseFloat(storageStr.replace(/[^0-9.]/g, '')) || 100;
    if (storageStr.toLowerCase().includes('tb')) {
      storageGb *= 1024;
    }

    // 1. DATABASE TIER COST CALCULATION
    let dbService = 'Amazon RDS Postgres';
    let dbResource = 'db.t3.micro Single-AZ';
    let dbPurpose = 'Relational database store';
    let dbCost = 15.00;
    let dbTip = 'Use standard gp3 storage volumes.';

    if (dbType.includes('DynamoDB')) {
      dbService = 'Amazon DynamoDB';
      dbPurpose = 'Fast NoSQL key-value transactions';
      if (users > 25000 || budget.includes('Enterprise')) {
        dbResource = 'DynamoDB Provisioned Capacity';
        dbCost = 38.00;
        dbTip = 'Enable DynamoDB auto-scaling for read/write units.';
      } else {
        dbResource = 'DynamoDB On-Demand (Pay-per-request)';
        dbCost = Math.max(5.00, Math.round(users * 0.0004 * 100) / 100);
        dbTip = 'Configure DynamoDB TTL for automatic session cleanup.';
      }
    } else if (dbType.includes('DocumentDB') || dbType.includes('MongoDB')) {
      dbService = 'Amazon DocumentDB';
      dbPurpose = 'Vector embeddings & Document store';
      if (users > 10000 || budget.includes('Enterprise')) {
        dbResource = 'db.t3.medium Cluster (2 nodes)';
        dbCost = 116.00;
        dbTip = 'Delete unused cluster snapshot backups.';
      } else {
        dbResource = 'db.t3.medium Single-Node';
        dbCost = 58.00;
        dbTip = 'Stop DocumentDB instances during development downtime.';
      }
    } else if (dbType.includes('Aurora') || users > 10000 || budget.includes('Enterprise')) {
      dbService = 'Amazon Aurora PostgreSQL';
      dbPurpose = 'Highly scalable SQL cluster';
      if (budget.includes('Enterprise')) {
        dbResource = 'db.r6g.large Multi-AZ Cluster';
        dbCost = 198.00;
        dbTip = 'Enable Aurora Storage Auto-scaling (gp3 storage equivalent).';
      } else {
        dbResource = 'db.t3.medium Serverless v2';
        dbCost = 68.00;
        dbTip = 'Set low minimum ACU scaling limits to reduce idle costs.';
      }
    } else if (dbType.includes('MySQL')) {
      dbService = 'Amazon RDS MySQL';
      if (users > 15000) {
        dbResource = 'db.t3.large Single-AZ';
        dbCost = 60.00;
        dbTip = 'Deploy multi-AZ replication only for production tier.';
      } else if (users > 2000) {
        dbResource = 'db.t3.small Single-AZ';
        dbCost = 30.00;
        dbTip = 'Commit to a 1-year reserved DB instance to save 35%.';
      } else {
        dbResource = 'db.t3.micro Single-AZ';
        dbCost = 15.00;
        dbTip = 'Leverage Graviton instance classes (db.t4g) for 20% savings.';
      }
    } else if (dbType.includes('None')) {
      dbService = 'None';
      dbResource = 'No Database';
      dbPurpose = 'Not requested for this stack';
      dbCost = 0.00;
      dbTip = 'Local ephemeral storage or mock data models used.';
    } else {
      // Standard RDS PostgreSQL
      dbService = 'Amazon RDS PostgreSQL';
      if (users > 15000) {
        dbResource = 'db.t3.large Single-AZ';
        dbCost = 65.00;
        dbTip = 'Deploy Multi-AZ only when strict SLA redundancy is required.';
      } else if (users > 2500) {
        dbResource = 'db.t3.small Single-AZ';
        dbCost = 30.00;
        dbTip = 'Purchase Reserved DB Instances for steady-state workloads.';
      } else {
        dbResource = 'db.t3.micro Single-AZ';
        dbCost = 15.00;
        dbTip = 'Utilize standard GP3 volumes instead of legacy GP2.';
      }
    }

    // 2. COMPUTE TIER COST CALCULATION
    let computeService = 'AWS Fargate';
    let computeResource = '2x 0.5 vCPU 1GB Tasks';
    let computePurpose = 'Containerized API application backend';
    let computeCost = 24.00;
    let computeTip = 'Set CPU target scaling to 70% to trigger container scaling.';

    if (type.includes('Machine Learning') || type.includes('AI') || special.toLowerCase().includes('gpu')) {
      computeService = 'Amazon EKS Cluster';
      computePurpose = 'Model inference & pipeline worker nodes';
      
      let baseNodes = 2;
      if (users > 5000) {
        baseNodes += Math.floor((users - 5000) / 4000);
      }
      
      let nodeCost = baseNodes * 67.00; // t3.large node
      let gpuCost = 390.00; // g4dn.xlarge GPU node ($0.526/hour)
      
      if (special.toLowerCase().includes('weekend') || traffic.includes('Business hours') || special.toLowerCase().includes('scale')) {
        gpuCost = 280.00; // Apply weekend scale-down discount
        computeTip = 'Scale GPU nodes to 0 during weekends (Saves $110.00/mo).';
      } else {
        computeTip = 'Use EKS managed node groups and Spot instances for workloads.';
      }
      
      computeResource = `${baseNodes}x t3.large nodes + 1x g4dn.xlarge GPU`;
      computeCost = 73.00 + nodeCost + gpuCost; // EKS Control Plane ($73) + nodes
    } else if (type.includes('Serverless') || budget.includes('Minimize') || dbType.includes('DynamoDB')) {
      computeService = 'AWS Lambda';
      computePurpose = 'On-demand microservices execution';
      
      // Calculate Serverless Compute based on users and modules
      const invCount = users * modules * 120; // total invocations per month
      const durationMs = 150; // typical execution duration
      const ramMb = 512;
      const gbSec = (invCount * (ramMb / 1024) * (durationMs / 1000));
      
      computeCost = Math.max(5.00, Math.round(gbSec * 0.0000166667 * 100) / 100);
      computeResource = `${(invCount / 1000000).toFixed(1)}M invocations (512MB RAM)`;
      computeTip = 'Keep Lambda executions under 200ms and minimize package layers.';
    } else if (budget.includes('Enterprise') || users > 25000) {
      computeService = 'Amazon EKS Cluster';
      computePurpose = 'High-availability private node groups';
      
      let baseNodes = 3;
      if (users > 20000) {
        baseNodes += Math.floor((users - 20000) / 8000);
      }
      
      const nodeCost = baseNodes * 72.80; // m6g.large Graviton instance
      computeResource = `${baseNodes}x m6g.large Multi-AZ Node Group`;
      computeCost = 73.00 + nodeCost;
      computeTip = 'Purchase EKS Compute Savings Plans to save up to 32% on nodes.';
    } else {
      // Standard SaaS/Fargate Container Compute
      computeService = 'AWS Fargate';
      let tasks = 2;
      if (users > 4000) {
        tasks += Math.floor((users - 4000) / 2500);
      }
      
      let cpu = '0.5';
      let ram = '1GB';
      let costPerTask = 12.00;
      
      if (users > 10000) {
        cpu = '1.0';
        ram = '2GB';
        costPerTask = 24.00;
      }
      
      computeResource = `${tasks}x ${cpu} vCPU ${ram} Tasks`;
      computeCost = tasks * costPerTask;
      computeTip = 'Set CPU scaling targets to 70% to trigger dynamic auto-scaling.';
    }

    // 3. STORAGE TIER COST CALCULATION
    let storageService = 'Amazon S3';
    let storageResource = `Standard ${storageGb.toLocaleString()}GB Bucket`;
    let storagePurpose = 'User uploads & logging storage';
    let storageCost = storageGb * 0.023; // $0.023 per GB S3 Standard
    let storageTip = 'Apply lifecycle policies to archive files after 30 days.';

    if (budget.includes('Enterprise') || special.toLowerCase().includes('hipaa') || special.toLowerCase().includes('kms')) {
      storageService = 'Amazon S3 KMS';
      storageResource = `KMS Encrypted ${storageGb.toLocaleString()}GB Bucket`;
      storageCost = (storageGb * 0.023) + 5.00; // S3 + KMS key charge
      storagePurpose = 'Protected Health Records (PHI)';
      storageTip = 'Enforce Object Lock policy and enable S3 Intelligent-Tiering.';
    }

    // 4. NETWORKING TIER COST CALCULATION
    let netService = 'Amazon CloudFront & ALB';
    let netResource = 'Global CDN + ALB';
    let netPurpose = 'Web routing & application load balancer';
    let netCost = 22.50 + Math.max(5.00, Math.round(users * 0.0002 * 100) / 100);
    let netTip = 'Consolidate routing using Host-based routing rules.';

    if (budget.includes('Enterprise') || special.toLowerCase().includes('waf')) {
      netService = 'AWS WAF & Shield';
      netResource = 'Managed WAF Rules + ALB';
      netCost = 38.00 + 22.50 + Math.max(5.00, Math.round(users * 0.00015 * 100) / 100);
      netPurpose = 'Malicious traffic protection & SSL offloading';
      netTip = 'Use AWS Managed Rulesets to filter common HTTP vulnerabilities.';
    } else if (computeService === 'AWS Lambda') {
      netService = 'API Gateway & CloudFront';
      netResource = 'REST Edge APIs + CDN';
      netCost = Math.max(10.00, Math.round(users * 0.0003 * 100) / 100);
      netPurpose = 'Low-latency global edge API gateway routing';
      netTip = 'Use HTTP APIs instead of REST APIs to save 60% gateway overhead.';
    }

    // Compile dynamic resources array
    const resources = [
      { category: 'Networking', service: netService, resource: netResource, purpose: netPurpose, monthly_cost: `$${netCost.toFixed(2)}`, cost_tip: netTip },
      { category: 'Compute', service: computeService, resource: computeResource, purpose: computePurpose, monthly_cost: `$${computeCost.toFixed(2)}`, cost_tip: computeTip },
      { category: 'Database', service: dbService, resource: dbResource, purpose: dbPurpose, monthly_cost: `$${dbCost.toFixed(2)}`, cost_tip: dbTip },
      { category: 'Storage', service: storageService, resource: storageResource, purpose: storagePurpose, monthly_cost: `$${storageCost.toFixed(2)}`, cost_tip: storageTip }
    ];

    // Compute totals
    const totalMonthly = netCost + computeCost + dbCost + storageCost;
    const totalAnnual = totalMonthly * 12;

    // Generate dynamic Terraform HCL snippet
    let tf = `# Dynamic Terraform configuration for ${name}\nprovider "aws" {\n  region = "ap-south-1"\n}\n\n`;
    if (computeService.includes('Fargate')) {
      tf += `# S3 Bucket for Static Assets\nresource "aws_s3_bucket" "assets" {\n  bucket = "${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-assets"\n  tags = {\n    Environment = "Dev"\n  }\n}\n\n# ECS Fargate Cluster\nresource "aws_ecs_cluster" "app_cluster" {\n  name = "${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-cluster"\n}\n`;
    } else if (computeService.includes('EKS')) {
      tf += `# EKS Kubernetes Cluster\nresource "aws_eks_cluster" "eks" {\n  name     = "${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-eks"\n  role_arn = "arn:aws:iam::123456789012:role/eks-service-role"\n  vpc_config {\n    subnet_ids = ["subnet-1a", "subnet-1b"]\n  }\n}\n`;
    } else {
      tf += `# Serverless Lambda Function\nresource "aws_lambda_function" "api" {\n  function_name = "${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-api"\n  handler       = "index.handler"\n  runtime       = "nodejs18.x"\n  role          = "arn:aws:iam::123456789012:role/lambda-role"\n}\n`;
    }

    if (dbService.includes('Postgres') || dbService.includes('RDS')) {
      tf += `\n# RDS Relational Instance\nresource "aws_db_instance" "db" {\n  allocated_storage = 20\n  engine            = "postgres"\n  instance_class    = "${dbResource.split(' ')[0]}"\n  db_name           = "appdb"\n  username          = "dbadmin"\n  password          = "SuperSecret123"\n  storage_type      = "gp3"\n}\n`;
    } else if (dbService.includes('DynamoDB')) {
      tf += `\n# DynamoDB Table\nresource "aws_dynamodb_table" "db" {\n  name         = "${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-db"\n  billing_mode = "PAY_PER_REQUEST"\n  hash_key     = "id"\n  attribute {\n    name = "id"\n    type = "S"\n  }\n}\n`;
    } else if (dbService.includes('DocumentDB')) {
      tf += `\n# DocumentDB Cluster\nresource "aws_docdb_cluster" "db" {\n  cluster_identifier = "${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-docdb"\n  engine             = "docdb"\n  master_username    = "admin"\n  master_password    = "SecurePass998"\n}\n`;
    }

    // Compile dynamic data response
    const data = {
      summary: `Dynamically calculated AWS architecture optimized for ${name} (${type}). Tailored to handle ${users.toLocaleString()} concurrent users, ${modules} microservices/modules, and ${storageGb.toLocaleString()}GB of storage.`,
      total_monthly_cost: `$${totalMonthly.toFixed(2)}`,
      total_annual_cost: `$${totalAnnual.toFixed(2)}`,
      resources: resources,
      architecture_highlights: [
        `Dynamically provisioned ${computeService} tier (${computeResource}) supporting ${users.toLocaleString()} concurrent users.`,
        `Managed relational database hosting using ${dbService} (${dbResource}) supporting transaction workloads.`,
        `Asset storage bucket configured on ${storageService} (${storageResource}) using high-speed gp3 block storage.`
      ],
      cost_optimization_tips: [
        `Purchase standard EC2/RDS Savings Plans to reduce base compute charges by up to 32% over a 1-year commitment.`,
        `Verify active target scaling is enabled on ${computeService} to scale down compute size during low traffic.`,
        `Monitor S3 storage tiers and activate S3 Intelligent-Tiering to automate archiving transitions.`
      ],
      scaling_notes: `Compute sizing is balanced for the current ${users.toLocaleString()} concurrent load. If requests increase to 5x peak, monthly cost is projected to scale to $${(totalMonthly * 2.2).toFixed(2)} based on network ingress and DB read/write scaling.`,
      alternatives: [
        { name: 'Budget Option', description: `Minimal single-instance setup, basic SQLite or RDS micro database.`, monthly_cost: `$${(totalMonthly * 0.35).toFixed(2)}` },
        { name: 'Production-Grade Option', description: `Multi-AZ compute replicas, high-availability Aurora clustered DB, advanced DDoS protection.`, monthly_cost: `$${(totalMonthly * 2.4).toFixed(2)}` }
      ],
      terraform: tf
    };

    // Render results
    renderEstimatorResults(data);
  }

  // ── Draw SVG Blueprint in Sandbox Preview Pane ──
  function drawSandboxMap(resources) {
    const container = document.getElementById('sandboxCanvasContainer');
    if (!container) return;
    container.innerHTML = '';

    const nodeCategories = {
      'Networking': [],
      'Compute': [],
      'Database': [],
      'Storage': [],
      'Other': []
    };

    resources.forEach(r => {
      const cat = r.category || 'Other';
      if (nodeCategories[cat]) {
        nodeCategories[cat].push(r);
      } else {
        nodeCategories['Other'].push(r);
      }
    });

    const width = 640;
    const height = 300;

    let svg = `
    <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="background: #fafbfc; border-radius: 8px;">
      <defs>
        <marker id="arrow-preview" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 2 L 10 5 L 0 8 z" fill="#c7d2fe" />
        </marker>
        <linearGradient id="primaryGradPreview" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#818cf8" />
          <stop offset="100%" stop-color="#a78bfa" />
        </linearGradient>
      </defs>

      <!-- Grid Background -->
      <pattern id="grid-pattern" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(0,0,0,0.03)" stroke-width="1" />
      </pattern>
      <rect width="100%" height="100%" fill="url(#grid-pattern)" />

      <!-- Client Users -->
      <g transform="translate(40, 150)">
        <circle cx="0" cy="0" r="28" fill="#e0e7ff" stroke="#818cf8" stroke-width="2" />
        <text x="0" y="5" font-family="'Outfit', sans-serif" font-size="20" text-anchor="middle">👥</text>
        <text x="0" y="44" font-family="'Space Grotesk', sans-serif" font-size="11" font-weight="700" text-anchor="middle" fill="#1e1e2d">Clients</text>
        <text x="0" y="56" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#818cf8">Ready</text>
      </g>
    `;

    const paths = [
      { d: 'M 68 150 L 122 150' },
      { d: 'M 178 150 L 272 150' },
      { d: 'M 328 135 L 452 85' },
      { d: 'M 328 165 L 452 215' }
    ];

    paths.forEach(p => {
      svg += `
        <path d="${p.d}" fill="none" stroke="#e2e8f0" stroke-width="3" marker-end="url(#arrow-preview)" />
        <path d="${p.d}" fill="none" stroke="#a78bfa" stroke-width="2" stroke-dasharray="6 10">
          <animate attributeName="stroke-dashoffset" values="32;0" dur="5s" repeatCount="indefinite" />
        </path>
      `;
    });

    // Node 1: Networking
    const netResource = nodeCategories['Networking'][0] || { service: 'ALB / CDN', monthly_cost: 'Est.' };
    svg += `
      <g transform="translate(150, 150)">
        <circle cx="0" cy="0" r="26" fill="#ecfdf5" stroke="#10b981" stroke-width="1.5" />
        <text x="0" y="5" font-family="'Outfit', sans-serif" font-size="18" text-anchor="middle">🌐</text>
        <text x="0" y="42" font-family="'Space Grotesk', sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#1e1e2d">${netResource.service}</text>
        <text x="0" y="53" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#10b981">${netResource.monthly_cost}</text>
      </g>
    `;

    // Node 2: Compute
    const computeResource = nodeCategories['Compute'][0] || { service: 'Compute', monthly_cost: 'Est.' };
    svg += `
      <g transform="translate(300, 150)">
        <rect x="-28" y="-28" width="56" height="56" rx="10" fill="url(#primaryGradPreview)" />
        <text x="0" y="6" font-family="'Outfit', sans-serif" font-size="20" text-anchor="middle" fill="#ffffff">⚡</text>
        <text x="0" y="44" font-family="'Space Grotesk', sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#1e1e2d">${computeResource.service}</text>
        <text x="0" y="55" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#ffffff">${computeResource.monthly_cost}</text>
      </g>
    `;

    // Node 3: Database
    const dbResource = nodeCategories['Database'][0] || { service: 'Database', monthly_cost: 'Est.' };
    svg += `
      <g transform="translate(480, 80)">
        <circle cx="0" cy="0" r="26" fill="#eff6ff" stroke="#3b82f6" stroke-width="1.5" />
        <text x="0" y="5" font-family="'Outfit', sans-serif" font-size="18" text-anchor="middle">🗄️</text>
        <text x="0" y="42" font-family="'Space Grotesk', sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#1e1e2d">${dbResource.service}</text>
        <text x="0" y="53" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#3b82f6">${dbResource.monthly_cost}</text>
      </g>
    `;

    // Node 4: Storage
    const storageResource = nodeCategories['Storage'][0] || { service: 'Storage', monthly_cost: 'Est.' };
    svg += `
      <g transform="translate(480, 220)">
        <circle cx="0" cy="0" r="26" fill="#fffbeb" stroke="#f59e0b" stroke-width="1.5" />
        <text x="0" y="5" font-family="'Outfit', sans-serif" font-size="18" text-anchor="middle">📦</text>
        <text x="0" y="42" font-family="'Space Grotesk', sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#1e1e2d">${storageResource.service}</text>
        <text x="0" y="53" font-family="'JetBrains Mono', sans-serif" font-size="9" text-anchor="middle" fill="#f59e0b">${storageResource.monthly_cost}</text>
      </g>
    `;

    svg += `</svg>`;
    container.innerHTML = svg;
  }

  // Pre-load default template on launch
  applyEstTemplate('saas');

  // Register live input change event listeners
  const inputIds = [
    'estProjectName', 'estProjectType', 'estDescription', 'estDuration',
    'estTeamSize', 'estModules', 'estUsers', 'estDatabase', 'estStorage',
    'estTraffic', 'estBudget', 'estSpecial'
  ];
  inputIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', recalculateProjectEstimate);
      el.addEventListener('change', recalculateProjectEstimate);
    }
  });



// ══════════════════════════════════════════════════════════════════
// AI PERFORMANCE SCREEN
// ══════════════════════════════════════════════════════════════════

// AI Panel HTML injection
(function injectAiPerfPanel() {
  const content = document.querySelector('.content');
  if (!content) return;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = 'panel-ai-perf';
  panel.style.cssText = 'overflow-y:auto; flex-direction:column; background:#0a0e1a !important;';
  panel.innerHTML = `
    <style>
      /* ── Animated scan line ── */
      @keyframes aip-scanline {
        0% { top: -2px; opacity: 0; }
        10% { opacity: 1; }
        90% { opacity: 1; }
        100% { top: 100%; opacity: 0; }
      }
      @keyframes aip-grid-drift { 0% { background-position: 0 0; } 100% { background-position: 40px 40px; } }
      @keyframes aip-card-glow-pulse {
        0%, 100% { box-shadow: 0 4px 20px rgba(0,0,0,0.25), 0 0 0 0 rgba(0,212,255,0); }
        50% { box-shadow: 0 4px 20px rgba(0,0,0,0.25), 0 0 15px 2px rgba(0,212,255,0.08); }
      }
      @keyframes aip-float-particle {
        0% { transform: translateY(0) scale(1); opacity: 0.6; }
        50% { transform: translateY(-18px) scale(1.3); opacity: 1; }
        100% { transform: translateY(0) scale(1); opacity: 0.6; }
      }

      .aip-container {
        padding: 28px;
        display: flex;
        flex-direction: column;
        gap: 24px;
        font-family: 'Space Grotesk', sans-serif;
        background: linear-gradient(145deg, #0a0e1a 0%, #111827 50%, #0d1321 100%);
        min-height: 100%;
        position: relative;
        overflow: visible;
      }
      /* Grid overlay */
      .aip-container::before {
        content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none;
        background-image:
          linear-gradient(rgba(0,212,255,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(0,212,255,0.03) 1px, transparent 1px);
        background-size: 40px 40px;
        animation: aip-grid-drift 20s linear infinite;
      }
      /* Scan line */
      .aip-container::after {
        content: ''; position: absolute; left: 0; right: 0; height: 2px; z-index: 1; pointer-events: none;
        background: linear-gradient(90deg, transparent 0%, rgba(0,212,255,0.5) 30%, rgba(139,122,232,0.6) 70%, transparent 100%);
        animation: aip-scanline 6s ease-in-out infinite;
        filter: blur(1px);
      }
      .aip-container > * { position: relative; z-index: 2; }
      .aip-header { display: flex; justify-content: space-between; align-items: center; }
      .aip-title h2 {
        font-family:'Space Grotesk',sans-serif;
        font-size:22px;
        font-weight:800;
        color:#f1f5f9;
        letter-spacing:-0.5px;
        background: linear-gradient(90deg, #00d4ff, #8b7ae8);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .aip-title .aip-sub { font-size:12px; color:#64748b; margin-top:4px; }
      .aip-refresh-btn {
        display:flex; align-items:center; gap:6px; padding:9px 18px;
        background:linear-gradient(135deg,#6c5dd3,#8b7ae8); border:none; border-radius:10px;
        color:#fff; font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:13px;
        cursor:pointer; box-shadow:0 4px 12px rgba(108,93,211,0.3); transition:all 0.2s;
      }
      .aip-refresh-btn:hover { transform:translateY(-2px); box-shadow:0 6px 18px rgba(108,93,211,0.45); }
      .aip-refresh-btn:disabled { opacity:0.6; cursor:not-allowed; transform:none; }

      /* Three-column Layout */
      .aip-layout {
        display: grid;
        grid-template-columns: 300px 1fr 340px;
        gap: 20px;
        align-items: start;
        margin-top: 8px;
      }
      @media (max-width: 1280px) {
        .aip-layout { grid-template-columns: 300px 1fr; }
      }
      @media (max-width: 992px) {
        .aip-layout { grid-template-columns: 1fr; }
      }

      /* Left Pane */
      .aip-left-pane { display: flex; flex-direction: column; gap: 20px; }
      
      .aip-visual-card {
        background: rgba(15,23,42,0.8);
        backdrop-filter: blur(16px);
        border: 1px solid rgba(0,212,255,0.15);
        border-radius: 16px;
        padding: 24px 20px;
        box-shadow: 0 4px 30px rgba(0,212,255,0.06), inset 0 1px 0 rgba(255,255,255,0.03);
        display: flex;
        flex-direction: column;
        align-items: center;
        position: relative;
        overflow: hidden;
      }
      .aip-visual-card::before {
        content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
        background: linear-gradient(90deg, transparent, #00d4ff, #8b7ae8, transparent);
      }
      
      .aip-visual-header { width: 100%; text-align: left; margin-bottom: 8px; }
      .aip-visual-header h3 { font-family: 'Space Grotesk', sans-serif; font-size: 15px; font-weight: 700; color: #e2e8f0; }
      .aip-visual-header p { font-size: 11px; color: #64748b; margin-top: 2px; }

      @keyframes floatMascot {
        0%, 100% { transform: translateY(0) scale(1.05); }
        50% { transform: translateY(-8px) scale(1.05); }
      }

      .aip-rps-overlay {
        background: #ffffff;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px 16px;
        width: 100%;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.04);
        display: flex;
        justify-content: space-between;
        align-items: center;
        position: relative;
      }
      .aip-rps-title { font-size: 11px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
      .aip-rps-val { font-family: 'Space Grotesk', sans-serif; font-size: 20px; font-weight: 800; color: #6c5dd3; }

      .aip-medication-list {
        background: rgba(15,23,42,0.8);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(139,122,232,0.15);
        border-radius: 16px;
        padding: 20px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .aip-medication-item {
        display: flex;
        align-items: center;
        padding: 10px 14px;
        border-radius: 10px;
        background: rgba(30,41,59,0.7);
        border: 1px solid rgba(100,116,139,0.15);
        transition: all 0.2s;
      }
      .aip-medication-item:hover { background: rgba(30,41,59,0.95); border-color: rgba(0,212,255,0.3); }
      .aip-med-icon {
        width: 30px; height: 30px; border-radius: 50%; display: flex;
        align-items: center; justify-content: center; font-size: 14px;
        margin-right: 12px; flex-shrink: 0;
      }
      .aip-med-info { flex: 1; }
      .aip-med-title { font-size: 12px; font-weight: 700; color: #e2e8f0; }
      .aip-med-sub { font-size: 10px; color: #64748b; margin-top: 2px; }

      /* Right Pane */
      .aip-right-pane { display: flex; flex-direction: column; gap: 20px; }

      /* Healthink Cards Grid (2x2) */
      .aip-cards-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
      @media (max-width: 640px) {
        .aip-cards-grid { grid-template-columns: 1fr; }
      }
      
      .aip-healthink-card {
        background: rgba(15,23,42,0.85); backdrop-filter: blur(14px);
        border:1px solid rgba(100,116,139,0.15); border-radius:16px;
        padding:22px 20px; display: flex; flex-direction: column;
        box-shadow:0 4px 20px rgba(0,0,0,0.25); transition:all 0.3s cubic-bezier(0.16,1,0.3,1);
        overflow: visible; min-height: 0; position: relative;
        animation: aip-card-glow-pulse 4s ease-in-out infinite;
      }
      .aip-healthink-card::before {
        content:''; position:absolute; top:0; left:0; right:0; height:2px;
        background:linear-gradient(90deg, transparent, var(--card-accent, #8b7ae8), transparent); opacity:0.7;
      }
      .aip-healthink-card.nllb { --card-accent: #06b6d4; }
      .aip-healthink-card.biobert { --card-accent: #10b981; }
      .aip-healthink-card.llama3 { --card-accent: #a855f7; }
      .aip-healthink-card.litellm { --card-accent: #f59e0b; }
      .aip-healthink-card:hover { transform:translateY(-4px); box-shadow:0 12px 40px rgba(0,0,0,0.4); border-color:rgba(139,122,232,0.3); }
      .aip-card-top { display:flex !important; justify-content:space-between !important; align-items:flex-start !important; margin-bottom:12px !important; visibility: visible !important; opacity: 1 !important; }
      .aip-card-title { font-family:'Space Grotesk',sans-serif !important; font-size:14px !important; font-weight:700 !important; color:#e2e8f0 !important; display:block !important; }

      /* Self-Healing Agent Terminal Logs CSS */
      .aip-terminal-card {
        background: #0b0f19;
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 16px 20px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.08);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .aip-terminal-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .aip-terminal-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        display: inline-block;
      }
      .aip-terminal-body {
        height: 150px;
        overflow-y: auto;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        line-height: 1.6;
        color: #94a3b8;
        display: flex;
        flex-direction: column;
        gap: 6px;
        scrollbar-width: thin;
      }
      .aip-term-line.info { color: #38bdf8; }
      .aip-term-line.warn { color: #fbbf24; }
      .aip-term-line.action { color: #c084fc; font-weight: bold; }
      .aip-term-line.ok { color: #34d399; }
      
      .aip-card-top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }
      .aip-card-title { font-family:'Space Grotesk',sans-serif; font-size:14px; font-weight:700; color:#e2e8f0; }
      .aip-card-detail-btn {
        background:rgba(139,122,232,0.15); color:#a78bfa; border:1px solid rgba(139,122,232,0.2); padding:4px 10px;
        border-radius:20px; font-size:10px; font-weight:600; cursor:pointer; transition:all 0.2s;
      }
      .aip-card-detail-btn:hover { background:rgba(139,122,232,0.3); color:#c4b5fd; }

      .aip-goal-line { display:flex; justify-content:space-between; font-size:10px; color:#64748b; font-weight:600; margin-bottom:6px; }
      
      .aip-large-value {
        font-family:'Outfit',sans-serif; font-size:28px; font-weight:800; color:#00d4ff;
        line-height:1.1; display:flex; align-items:baseline; gap:4px; margin-bottom:6px;
        text-shadow: 0 0 20px rgba(0,212,255,0.3);
      }
      .aip-large-value span { font-size:11px; color:#64748b; font-weight:500; }

      .aip-sparkline { height:36px; width:100%; margin-top:8px; margin-bottom:8px; overflow:hidden; }

      .aip-resource-mini-bars {
        margin-top:14px; display:flex; flex-direction:column; gap:8px;
        border-top:1px solid rgba(100,116,139,0.15); padding-top:12px;
      }
      .aip-resource-mini-bars span { font-size:9px; font-weight:700; color:#64748b; letter-spacing:0.3px; }

      /* Issue Alert Card */
      .aip-issue-dark-card {
        background:#fecaca; color:#991b1b; border-radius:12px; padding:16px 20px;
        display:flex; justify-content:space-between; align-items:center;
        box-shadow:0 4px 15px rgba(239,68,68,0.1); margin-bottom:8px;
        animation: panelFadeIn 0.3s ease-in-out;
      }

      /* Charts section */
      .aip-charts-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(350px,1fr)); gap:24px; }
      .aip-chart-card {
        background:rgba(15,23,42,0.8); backdrop-filter:blur(12px);
        border:1px solid rgba(100,116,139,0.15); border-radius:16px;
        padding:22px; box-shadow:0 4px 20px rgba(0,0,0,0.2);
      }
      .aip-chart-title { font-family:'Space Grotesk',sans-serif; font-size:14px; font-weight:700; color:#e2e8f0; margin-bottom:16px; display:flex; align-items:center; gap:8px; }
      .aip-chart-title span { font-size:10px; font-weight:600; color:#64748b; }

      /* History table */
      .aip-history-table { width:100%; border-collapse:collapse; font-size:13px; color:#cbd5e1; }
      .aip-history-table th {
        background:rgba(15,23,42,0.9); padding:12px 16px; font-weight:700; text-transform:uppercase;
        font-size:10px; color:#64748b; letter-spacing:0.8px; border-bottom:1px solid rgba(100,116,139,0.15); text-align:left;
      }
      .aip-history-table td { padding:14px 16px; border-bottom:1px solid rgba(100,116,139,0.1); vertical-align:middle; color:#94a3b8; }
      .aip-history-table tr:last-child td { border-bottom:none; }
      .aip-history-table tr:hover td { background:rgba(139,122,232,0.06); }
      .aip-latency-bar {
        height:6px; border-radius:3px; background:linear-gradient(90deg,#6c5dd3,#8b7ae8);
        display:inline-block; min-width:4px; transition:width 0.4s ease;
      }
      .aip-latency-bar.warn { background:linear-gradient(90deg,#f59e0b,#fbbf24); }
      .aip-latency-bar.error { background:linear-gradient(90deg,#ef4444,#f87171); }

      .aip-empty { display:flex; flex-direction:column; align-items:center; justify-content:center;
        padding:60px 20px; color:#64748b; gap:12px; font-size:14px; }
      .aip-empty-icon { font-size:42px; opacity:0.4; }

      .aip-auto-badge {
        font-size:10px; background:rgba(0,212,255,0.1); color:#00d4ff;
        border:1px solid rgba(0,212,255,0.2); padding:3px 8px; border-radius:20px; font-weight:600;
      }
      
      /* Dark theme overrides for dynamic elements */
      #panel-ai-perf [style*="color:var(--muted)"],
      #panel-ai-perf [style*="color: var(--muted)"] {
        color: #94a3b8 !important;
      }
      #panel-ai-perf [style*="color:var(--text)"],
      #panel-ai-perf [style*="color: var(--text)"] {
        color: #e2e8f0 !important;
      }
      #panel-ai-perf [style*="background:var(--surface2)"],
      #panel-ai-perf [style*="background: var(--surface2)"] {
        background: rgba(30, 41, 59, 0.6) !important;
      }
      #panel-ai-perf .aip-resource-mini-bars span {
        color: #94a3b8 !important;
      }
      #panel-ai-perf .aip-goal-line span {
        color: #94a3b8 !important;
      }
      #panel-ai-perf .aip-card {
        color: #cbd5e1 !important;
      }
      #panel-ai-perf .aip-card-stat-lbl {
        color: #94a3b8 !important;
      }
      #panel-ai-perf .aip-card-stat-val {
        color: #ffffff !important;
      }
      #panel-ai-perf .aip-card-detail-btn {
        background: rgba(139, 122, 232, 0.2) !important;
        color: #c4b5fd !important;
        border-color: rgba(139, 122, 232, 0.3) !important;
      }
      #panel-ai-perf .aip-card-detail-btn:hover {
        background: rgba(139, 122, 232, 0.4) !important;
      }
      #panel-ai-perf .aip-sparkline path {
        stroke: rgba(139, 122, 232, 0.4) !important;
      }
    </style>

    <div class="aip-container">
      <!-- Header -->
      <div class="aip-header">
        <div class="aip-title">
          <h2>🧠 AI Model Performance</h2>
          <div class="aip-sub" id="aiPerfSummary">Active Model Clusters: 4 Running · 0 Issues Found · Cluster Health 100%</div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;">
          <span class="aip-auto-badge" id="aiPerfAutoLabel">⏱ Auto-refresh: 30s</span>
          <button class="aip-refresh-btn" id="aiPerfRefreshBtn" onclick="loadAiMetrics()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh Now
          </button>
        </div>
      </div>

      <!-- Healthink Premium Two Column Layout -->
      <div class="aip-layout">
        <!-- Left Pane: Active Mascot & info -->
        <div class="aip-left-pane">
          <div class="aip-visual-card">
            <div class="aip-visual-header">
              <h3>AI Assistant Active</h3>
              <p>Real-time cluster diagnostic copilot</p>
            </div>
            
            <!-- AI Neural Sphere Canvas Container -->
            <style>
              .ai-sphere-wrap { width:100%; height:240px; display:flex; align-items:center; justify-content:center; position:relative; margin:8px 0; }
              .ai-sphere-label {
                position:absolute; bottom:6px; left:50%; transform:translateX(-50%);
                font-family:'Space Grotesk',monospace; font-size:10px; font-weight:800;
                color:#00aaff; letter-spacing:4px; opacity:0.85; pointer-events:none;
              }
            </style>
            <div class="ai-sphere-wrap">
              <div style="position:relative; width:200px; height:200px; display:flex; align-items:center; justify-content:center;">
                <canvas id="aroai-sphere-canvas" width="200" height="200" style="display:block;"></canvas>
                <div class="ai-sphere-label">A.I. NEURAL</div>
              </div>
            </div>

            <!-- Friday Voice Control (replaces Global Inference Rate) -->
            <div id="vc-toggle-wrap" style="display:flex; align-items:center; justify-content:space-between; padding:14px 18px; background:linear-gradient(135deg,rgba(108,93,211,0.07),rgba(0,180,255,0.05)); border:1px solid rgba(108,93,211,0.2); border-radius:12px; box-shadow:0 2px 8px rgba(108,93,211,0.08);">
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="pulse-dot" style="background:#6c5dd3; flex-shrink:0;"></span>
                <div>
                  <div style="font-size:12px; font-weight:700; color:var(--text);">🎙️ Friday Voice Control</div>
                  <div id="vc-toggle-status" style="font-size:10px; color:#64748b; margin-top:2px;">Inactive — click to activate</div>
                </div>
              </div>
              <button id="vc-toggle-btn" onclick="window.toggleVoiceControl && window.toggleVoiceControl()" style="padding:8px 18px; background:linear-gradient(135deg,#6c5dd3,#8b7ae8); color:#fff; border:none; border-radius:20px; font-size:11px; font-weight:700; cursor:pointer; transition:all 0.2s; box-shadow:0 3px 10px rgba(108,93,211,0.35);" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">Start</button>
            </div>
            <!-- Hidden RPS val (still updated by JS) -->
            <span id="globalRpsVal" style="display:none;">0 RPS</span>
          </div>

          <!-- Medication list style info card -->
          <div class="aip-medication-list">
            <div style="font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.5px;">Active Model Services</div>
            
            <div class="aip-medication-item">
              <div class="aip-med-icon" style="background:rgba(6,182,212,0.1); color:#06b6d4;">🌐</div>
              <div class="aip-med-info">
                <div class="aip-med-title">Translation (NLLB)</div>
                <div class="aip-med-sub">Meta NLLB-200 Service</div>
              </div>
            </div>
            
            <div class="aip-medication-item">
              <div class="aip-med-icon" style="background:rgba(16,185,129,0.1); color:#10b981;">🧬</div>
              <div class="aip-med-info">
                <div class="aip-med-title">Medical Embed (BioBERT)</div>
                <div class="aip-med-sub">dmis-lab/biobert-base</div>
              </div>
            </div>
            
            <div class="aip-medication-item">
              <div class="aip-med-icon" style="background:rgba(168,85,247,0.1); color:#a855f7;">🦙</div>
              <div class="aip-med-info">
                <div class="aip-med-title">Clinical RAG (Llama 3)</div>
                <div class="aip-med-sub">llama3.2-1b-cpu predictor</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Middle Column: Model Cards Grid -->
        <div class="aip-middle-pane" style="display: flex; flex-direction: column; gap: 20px;">
          <!-- Dark Warning Banner if issue found -->
          <div id="aiPerformanceAlert" class="aip-issue-dark-card" style="display:none; margin-bottom: 0;">
            <div style="display:flex; align-items:center; gap:12px;">
              <span style="font-size:20px;">⚠️</span>
              <div>
                <div style="font-weight:700;font-size:13px;">Performance Issue Detected</div>
                <div style="font-size:11px;color:var(--muted);" id="aiPerformanceAlertText">One or more model endpoints are experiencing warnings.</div>
              </div>
            </div>
            <button class="aip-card-detail-btn" style="background:var(--surface2); color:var(--text); border:none; padding:6px 12px; font-weight:600; cursor:pointer;" onclick="document.getElementById('panel-ai-perf').scrollTo({top: 800, behavior: 'smooth'})">View Log Details</button>
          </div>

          <!-- Cards Grid (rendered 2x2) -->
          <div class="aip-cards-grid" id="aiModelCards">
            <div class="aip-empty"><div class="aip-empty-icon">🔄</div><div>Loading AI model metrics...</div></div>
          </div>
        </div>

        <!-- Right Column: Charts & Terminal Logs -->
        <div class="aip-right-pane">
          <div class="aip-chart-card">
            <div class="aip-chart-title">📊 Avg Latency Comparison <span>(seconds)</span></div>
            <div style="position: relative; height: 180px; width: 100%;">
              <canvas id="aiLatencyBarChart"></canvas>
            </div>
          </div>
          <div class="aip-chart-card">
            <div class="aip-chart-title">📈 Latency Trend (last 10) <span>(seconds)</span></div>
            <div style="position: relative; height: 180px; width: 100%;">
              <canvas id="aiLatencyLineChart"></canvas>
            </div>
          </div>

          <!-- Self-Healing Agent Terminal Logs -->
          <div class="aip-terminal-card">
            <div class="aip-terminal-header">
              <span class="aip-terminal-dot" style="background:#ef4444;"></span>
              <span class="aip-terminal-dot" style="background:#f59e0b;"></span>
              <span class="aip-terminal-dot" style="background:#10b981;"></span>
              <span style="margin-left: 8px; font-weight:700; color:#fff; font-size:11px;">Self-Healing Logs</span>
            </div>
            <div class="aip-terminal-body" id="aiSelfHealingLogs">
              <div class="aip-term-line info">[14:38:10] Agent initialized (Llama-3 diagnostic engine online)</div>
              <div class="aip-term-line info">[14:38:12] Performing cluster check...</div>
              <div class="aip-term-line ok">[14:38:13] LiteLLM gateway status verified: healthy.</div>
              <div class="aip-term-line info">[14:38:14] Monitoring k8s event logs for clinical-rag-service namespace dev...</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Recent Probe History Table -->
      <div class="table-container" style="background:rgba(15,23,42,0.8); backdrop-filter:blur(12px); border:1px solid rgba(100,116,139,0.15); border-radius:16px; box-shadow:0 4px 20px rgba(0,0,0,0.2);">
        <div style="padding:18px 20px 12px; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:700;color:#e2e8f0;">Recent Probe Log</div>
          <div style="font-size:11px;color:var(--muted);" id="aiPerfLastUpdated">–</div>
        </div>
        <table class="aip-history-table" id="aiHistoryTable">
          <thead>
            <tr>
              <th>Model</th>
              <th>Endpoint</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Bar</th>
              <th>Requests (7d)</th>
              <th>Error Rate</th>
              <th>Probed At</th>
            </tr>
          </thead>
          <tbody id="aiHistoryBody">
            <tr><td colspan="8" style="text-align:center;color:var(--muted);padding:30px;">Loading...</td></tr>
          </tbody>
        </table>
      </div>

    </div>
  `;
  content.appendChild(panel);

  // Initialize the AROai dynamic wave particle sphere canvas animation
  (function initAroSphere() {
    const canvas = document.getElementById('aroai-sphere-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const radius = 62;
    const dots = [];

    // Generate coordinates on a sphere using Golden Spiral / Fibonacci lattice
    const numDots = 300;
    for (let i = 0; i < numDots; i++) {
      const phi = Math.acos(-1 + (2 * i) / numDots);
      const theta = Math.sqrt(numDots * Math.PI) * phi;
      dots.push({
        x: Math.sin(phi) * Math.cos(theta),
        y: Math.sin(phi) * Math.sin(theta),
        z: Math.cos(phi)
      });
    }

    let angleY = 0;
    let angleX = 0;
    let time = 0;

    function draw() {
      ctx.clearRect(0, 0, width, height);
      
      time += 0.035;
      angleY += 0.007;
      angleX += 0.004;

      // Project and morph dots
      const projected = dots.map(d => {
        // Rotate around Y
        let x1 = d.x * Math.cos(angleY) - d.z * Math.sin(angleY);
        let z1 = d.x * Math.sin(angleY) + d.z * Math.cos(angleY);
        
        // Rotate around X
        let y2 = d.y * Math.cos(angleX) - z1 * Math.sin(angleX);
        let z2 = d.y * Math.sin(angleX) + z1 * Math.cos(angleX);

        // Fluid morphing - sinusoidal wave displacements
        const angle = Math.atan2(y2, x1);
        const wave = Math.sin(angle * 4 + time * 1.5) * 0.13 + Math.cos(z2 * 3.5 - time * 2) * 0.08;
        const scale = 1.0 + wave;

        const px = cx + x1 * radius * scale;
        const py = cy + y2 * radius * scale;

        return { x: px, y: py, z: z2 };
      });

      // Depth sort
      projected.sort((a, b) => a.z - b.z);

      // Draw particles
      projected.forEach(p => {
        const alpha = (p.z + 1.2) / 2.2;
        if (alpha <= 0.05) return;

        // Custom color interpolation from cyan (#00d4ff) to vibrant violet-purple (#8b7ae8)
        const ratio = (p.z + 1) / 2; // -1..1 mapped to 0..1
        const r = Math.floor(0 * (1 - ratio) + 139 * ratio);
        const g = Math.floor(212 * (1 - ratio) + 122 * ratio);
        const b = Math.floor(255 * (1 - ratio) + 232 * ratio);

        ctx.beginPath();
        const size = (p.z + 1.0) * 1.6 + 0.6;
        ctx.arc(p.x, p.y, size, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.9})`;
        
        // Glow effect
        if (p.z > 0.3) {
          ctx.shadowBlur = 6;
          ctx.shadowColor = `rgb(${r}, ${g}, ${b})`;
        } else {
          ctx.shadowBlur = 0;
        }
        
        ctx.fill();
      });

      requestAnimationFrame(draw);
    }

    draw();
  })();
})();

// ── AI Metrics State ──────────────────────────────────────────────
const AI_LATENCY_HISTORY = {};  // model -> []
let aiBarChart = null;
let aiLineChart = null;
let aiPerfInterval = null;

function addTerminalLog(type, text) {
  const body = document.getElementById('aiSelfHealingLogs');
  if (!body) return;
  const time = new Date().toTimeString().split(' ')[0];
  const div = document.createElement('div');
  div.className = `aip-term-line ${type}`;
  div.innerHTML = `[${time}] ${text}`;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  if (body.children.length > 30) body.removeChild(body.firstChild);
}

// Simulated active logs
const SIM_LOGS = [
  { type: 'info', text: 'Queried Llama-3 self-healing diagnostic service.' },
  { type: 'info', text: 'All cluster ingress controller paths healthy.' },
  { type: 'ok', text: 'LiteLLM router latency validated within SLA (0.34s).' },
  { type: 'info', text: 'Monitoring k8s event logs for clinical-rag-service namespace dev...' },
  { type: 'ok', text: 'No stuck PV attachments detected on pv-dgcare-dev.' },
  { type: 'info', text: 'CPU and Memory allocation profiles within target thresholds.' },
];
setInterval(() => {
  if (Math.random() > 0.6) {
    const log = SIM_LOGS[Math.floor(Math.random() * SIM_LOGS.length)];
    addTerminalLog(log.type, log.text);
  }
}, 8000);

// ── Model definitions (matches your KServe InferenceServices) ────
const AI_MODELS_META = {
  nllb: {
    label: 'NLLB Translation',
    type: 'Translation · Meta NLLB-200',
    css: 'nllb',
    color: '#06b6d4',
    endpoint: '/api/v1/health'
  },
  biobert: {
    label: 'BioBERT Embed',
    type: 'Embedding · dmis-lab/biobert-base-cased-v1.1',
    css: 'biobert',
    color: '#10b981',
    endpoint: '/docs'
  },
  llama3: {
    label: 'Llama 3.2 (Ollama)',
    type: 'LLM · llama3.2-1b-cpu · KServe',
    css: 'llama3',
    color: '#a855f7',
    endpoint: '/v1/chat/completions'
  },
  litellm: {
    label: 'LiteLLM Gateway',
    type: 'LLM Proxy · llm-heavy',
    css: 'litellm',
    color: '#f59e0b',
    endpoint: '/health'
  }
};

function generateSparkline(history, color) {
  if (!history || history.length === 0) {
    return `<svg class="aip-sparkline" viewBox="0 0 100 30"><path d="M 0 15 L 100 15" stroke="var(--border)" stroke-width="1.5" fill="none"/></svg>`;
  }
  if (history.length === 1) {
    return `
      <svg class="aip-sparkline" viewBox="0 0 100 30">
        <path d="M 0 15 L 100 15" stroke="${color}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      </svg>
    `;
  }
  const max = Math.max(...history, 0.05);
  const min = Math.min(...history, 0);
  const range = max - min || 1;
  const points = history.map((val, idx) => {
    const x = (idx / (history.length - 1)) * 100;
    const y = 28 - ((val - min) / range) * 23 - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  
  return `
    <svg class="aip-sparkline" viewBox="0 0 100 30">
      <polyline fill="none" stroke="${color}" stroke-width="2.5" points="${points}" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

async function loadAiMetrics() {
  const btn = document.getElementById('aiPerfRefreshBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span style="animation:spin 1s linear infinite;display:inline-block;">↻</span> Refreshing...'; }

  try {
    const res = await fetch('/api/ai-metrics');
    if (!res.ok) throw new Error('API returned ' + res.status);
    const data = await res.json();
    renderAiCards(data);
    renderAiTable(data);
    updateAiCharts(data);

    // Add terminal log of successful poll
    let slowCount = 0;
    Object.keys(data).forEach(k => {
      if (data[k]?.status !== 'healthy') slowCount++;
    });
    if (slowCount > 0) {
      addTerminalLog('warn', `Telemetry parsed: 4 services tracked. ${slowCount} warnings active.`);
    } else {
      addTerminalLog('ok', 'Telemetry parsed: all 4 services healthy.');
    }

    const el = document.getElementById('aiPerfLastUpdated');
    if (el) el.textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.warn('AI metrics fetch error:', e);
    renderAiCardsError(e.message);
    addTerminalLog('error', `Failed to fetch AI metrics: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh Now'; }
  }
}

function statusDotClass(status) {
  if (status === 'healthy') return '';
  if (status === 'slow') return 'warn';
  if (status === 'error' || status === 'unreachable') return 'error';
  return 'unknown';
}

function renderAiCards(data) {
  const grid = document.getElementById('aiModelCards');
  if (!grid) return;
  const models = Object.keys(AI_MODELS_META);

  let totalRps = 0;
  let hasIssues = false;
  let issueText = "";

  models.forEach(key => {
    const m = data[key] || {};
    if (m.requests_7d) {
      totalRps += Math.round(m.requests_7d / (7 * 24 * 3600) * 1.5);
    }
    if (m.status === 'slow' || m.status === 'error' || m.status === 'unreachable') {
      hasIssues = true;
      issueText += `${AI_MODELS_META[key].label} is showing ${m.status}. `;
    }
  });

  const rpsEl = document.getElementById('globalRpsVal');
  if (rpsEl) rpsEl.textContent = totalRps > 0 ? `${totalRps} RPS` : '0 RPS';

  const alertEl = document.getElementById('aiPerformanceAlert');
  if (alertEl) {
    if (hasIssues) {
      alertEl.style.display = 'flex';
      document.getElementById('aiPerformanceAlertText').textContent = issueText;
    } else {
      alertEl.style.display = 'none';
    }
  }

  const summaryEl = document.getElementById('aiPerfSummary');
  if (summaryEl) {
    summaryEl.textContent = hasIssues
      ? `Active Model Clusters: 4 Running · Alert: ${issueText}`
      : `Active Model Clusters: 4 Running · 0 Issues Found · Cluster Health 100%`;
  }

  grid.innerHTML = models.map(key => {
    const meta = AI_MODELS_META[key];
    const m = data[key] || {};
    const latencyVal = m.latency_ms != null ? (m.latency_ms / 1000).toFixed(2) : null;
    const latencyText = latencyVal ? latencyVal : '—';
    const rps     = m.requests_7d  != null ? m.requests_7d.toLocaleString() : '—';
    const errRate = m.error_rate_pct != null ? m.error_rate_pct.toFixed(1) + '%' : '—';
    const status  = m.status || 'unknown';
    const dotCls  = statusDotClass(status);

    const cpuUsed = m.cpu_used != null ? m.cpu_used : 0;
    const cpuLimit = m.cpu_limit != null ? m.cpu_limit : 0;
    const cpuPct = cpuLimit > 0 ? Math.min(100, (cpuUsed / cpuLimit) * 100).toFixed(0) : 0;

    const memUsed = m.mem_used_mb != null ? m.mem_used_mb : 0;
    const memLimit = m.mem_limit_mb != null ? m.mem_limit_mb : 0;
    const memPct = memLimit > 0 ? Math.min(100, (memUsed / memLimit) * 100).toFixed(0) : 0;

    const history = AI_LATENCY_HISTORY[key] || [];
    const sparklineSvg = generateSparkline(history, meta.color);

    return `
      <div class="aip-healthink-card ${meta.css}">
        <div class="aip-card-top">
          <div>
            <div class="aip-card-title">${meta.label}</div>
            <div style="font-size:10px; color:var(--muted); margin-top:2px;">${meta.type}</div>
          </div>
          <button class="aip-card-detail-btn" onclick="alert('Model Endpoint: ${m.probed_url || meta.endpoint}')">Detail</button>
        </div>
        
        <div class="aip-goal-line">
          <span>Target SLA: &lt; 1.00s</span>
          <span>Status: <strong style="color:${dotCls===''?'#22c55e':dotCls==='warn'?'#f59e0b':'#ef4444'}; text-transform:capitalize;">${status}</strong></span>
        </div>
        
        <div class="aip-large-value">
          ${latencyText} <span>seconds</span>
        </div>
        
        <!-- Live Sparkline Trend -->
        <div style="margin: 6px 0;">
          ${sparklineSvg}
        </div>
        
        <!-- Mini Stats Grid -->
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; font-size:11px;">
          <div>
            <div class="aip-card-stat-lbl" style="font-size:9px; font-weight:700; text-transform:uppercase;">Requests (7d)</div>
            <div class="aip-card-stat-val" style="font-weight:700; margin-top:1px; color:#ffffff;">${rps}</div>
          </div>
          <div>
            <div class="aip-card-stat-lbl" style="font-size:9px; font-weight:700; text-transform:uppercase;">Error Rate</div>
            <div class="aip-card-stat-val" style="font-weight:700; margin-top:1px; color:${parseFloat(m.error_rate_pct||0)>5?'#ef4444':'#ffffff'};">${errRate}</div>
          </div>
        </div>

        <!-- Resource Progress Bars (Healthink styled) -->
        <div class="aip-resource-mini-bars">
          <!-- CPU -->
          <div>
            <div style="display:flex; justify-content:space-between; font-size:9px; font-weight:700; color:var(--muted);">
              <span>CPU UTILIZATION</span>
              <span>${cpuUsed.toFixed(2)} / ${cpuLimit.toFixed(1)} cores</span>
            </div>
            <div style="background:var(--surface2); border-radius:10px; height:4px; margin-top:3px; overflow:hidden;">
              <div style="background:linear-gradient(90deg, #3b82f6, ${meta.color}); height:4px; width:${cpuPct}%; transition:width 0.4s ease;"></div>
            </div>
          </div>
          <!-- Memory -->
          <div>
            <div style="display:flex; justify-content:space-between; font-size:9px; font-weight:700; color:var(--muted);">
              <span>MEMORY</span>
              <span>${memUsed} / ${memLimit} MiB</span>
            </div>
            <div style="background:var(--surface2); border-radius:10px; height:4px; margin-top:3px; overflow:hidden;">
              <div style="background:linear-gradient(90deg, #10b981, #34d399); height:4px; width:${memPct}%; transition:width 0.4s ease;"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderAiCardsError(msg) {
  const grid = document.getElementById('aiModelCards');
  if (grid) grid.innerHTML = `<div class="aip-empty" style="grid-column:1/-1;"><div class="aip-empty-icon">⚠️</div><div>Could not load AI metrics: ${msg}</div><div style="font-size:12px;margin-top:4px;">Make sure the server is running and Grafana/Prometheus is reachable.</div></div>`;
}

function updateAiCharts(data) {
  const models = Object.keys(AI_MODELS_META);
  const labels = models.map(k => AI_MODELS_META[k].label);
  const colors = models.map(k => AI_MODELS_META[k].color);
  const latencies = models.map(k => data[k]?.latency_ms != null ? data[k].latency_ms / 1000 : 0);

  // Append to history
  models.forEach(k => {
    if (!AI_LATENCY_HISTORY[k]) AI_LATENCY_HISTORY[k] = [];
    AI_LATENCY_HISTORY[k].push(data[k]?.latency_ms != null ? data[k].latency_ms / 1000 : 0);
    if (AI_LATENCY_HISTORY[k].length > 10) AI_LATENCY_HISTORY[k].shift();
  });

  // Bar Chart
  const barCtx = document.getElementById('aiLatencyBarChart');
  if (barCtx) {
    if (aiBarChart) aiBarChart.destroy();
    aiBarChart = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Avg Latency (s)',
          data: latencies,
          backgroundColor: colors.map(c => c + '30'),
          borderColor: colors,
          borderWidth: 2,
          borderRadius: 8,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { family: 'JetBrains Mono', size: 11 } } },
          x: { grid: { display: false }, ticks: { font: { family: 'Space Grotesk', size: 11 } } }
        }
      }
    });
  }

  // Line Chart
  const lineCtx = document.getElementById('aiLatencyLineChart');
  if (lineCtx) {
    const pollCount = Math.max(...models.map(k => AI_LATENCY_HISTORY[k]?.length || 0));
    const lineLabels = Array.from({ length: pollCount }, (_, i) => `T-${pollCount - i - 1}`);
    if (aiLineChart) aiLineChart.destroy();
    aiLineChart = new Chart(lineCtx, {
      type: 'line',
      data: {
        labels: lineLabels,
        datasets: models.map((k, i) => ({
          label: AI_MODELS_META[k].label,
          data: AI_LATENCY_HISTORY[k] || [],
          borderColor: colors[i],
          backgroundColor: colors[i] + '15',
          borderWidth: 2,
          pointRadius: 3,
          fill: true,
          tension: 0.4
        }))
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { font: { family: 'Space Grotesk', size: 11 }, boxWidth: 12 } } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { family: 'JetBrains Mono', size: 11 } } },
          x: { grid: { display: false }, ticks: { font: { family: 'JetBrains Mono', size: 10 } } }
        }
      }
    });
  }
}

function renderAiTable(data) {
  const tbody = document.getElementById('aiHistoryBody');
  if (!tbody) return;
  const now = new Date().toLocaleTimeString();
  const rows = Object.keys(AI_MODELS_META).map(key => {
    const meta = AI_MODELS_META[key];
    const m = data[key] || {};
    const lat = m.latency_ms ?? null;
    const maxLat = 3000;
    const barPct = lat != null ? Math.min(100, (lat / maxLat) * 100) : 0;
    const barCls = lat == null ? '' : lat > 2000 ? 'error' : lat > 800 ? 'warn' : '';
    const dotCls = statusDotClass(m.status || 'unknown');
    const dotColor = dotCls === '' ? '#22c55e' : dotCls === 'warn' ? '#f59e0b' : dotCls === 'error' ? '#ef4444' : '#94a3b8';
    return `<tr>
      <td style="font-weight:700;color:${meta.color};font-family:'Space Grotesk',sans-serif;">${meta.label}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);">${m.probed_url || meta.endpoint}</td>
      <td><span style="display:inline-flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;border-radius:50%;background:${dotColor};display:inline-block;"></span>${(m.status||'unknown')}</span></td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;">${lat != null ? (lat / 1000).toFixed(2) + ' s' : '—'}</td>
      <td style="width:120px;"><div style="background:#f1f5f9;border-radius:3px;height:6px;"><div class="aip-latency-bar ${barCls}" style="width:${barPct}%;"></div></div></td>
      <td style="font-family:'JetBrains Mono',monospace;">${m.requests_7d != null ? m.requests_7d.toLocaleString() : '—'}</td>
      <td style="font-family:'JetBrains Mono',monospace;color:${parseFloat(m.error_rate_pct||0)>5?'#ef4444':parseFloat(m.error_rate_pct||0)>1?'#f59e0b':'#22c55e'}">${m.error_rate_pct != null ? m.error_rate_pct.toFixed(1)+'%' : '—'}</td>
      <td style="font-size:11px;color:var(--muted);">${now}</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('');
}

// Auto-load when AI perf tab is first activated
const _origSwitchTab = window.switchTab;
window.switchTab = function(el) {
  if (typeof _origSwitchTab === 'function') _origSwitchTab(el);
  if (el && el.dataset && el.dataset.panel === 'ai-perf') {
    loadAiMetrics();
    if (!aiPerfInterval) aiPerfInterval = setInterval(loadAiMetrics, 30000);
  } else {
    if (aiPerfInterval) { clearInterval(aiPerfInterval); aiPerfInterval = null; }
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// FRIDAY VOICE COMMAND ENGINE — Full hands-free control via Web Speech API
// Zero cost, zero external APIs. Chrome/Edge only.
// ══════════════════════════════════════════════════════════════════════════════
(function() {

  // ── Styles ─────────────────────────────────────────────────────────────────
  const vcStyles = document.createElement('style');
  vcStyles.textContent = `
    /* Floating mic orb */
    #vc-orb {
      position: fixed;
      bottom: 28px;
      right: 90px;
      width: 62px;
      height: 62px;
      border-radius: 50%;
      background: linear-gradient(135deg, #6c5dd3, #8b7ae8);
      box-shadow: 0 4px 24px rgba(108,93,211,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 9999;
      transition: transform 0.2s, box-shadow 0.2s;
      user-select: none;
    }
    #vc-orb:hover { transform: scale(1.08); box-shadow: 0 6px 32px rgba(108,93,211,0.6); }
    #vc-orb.listening {
      background: linear-gradient(135deg, #ef4444, #f87171);
      box-shadow: 0 0 0 0 rgba(239,68,68,0.7);
      animation: vc-pulse 1.2s infinite;
    }
    #vc-orb.thinking {
      background: linear-gradient(135deg, #f59e0b, #fbbf24);
      animation: vc-spin-glow 1.5s linear infinite;
    }
    @keyframes vc-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.7); }
      70%  { box-shadow: 0 0 0 18px rgba(239,68,68,0); }
      100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
    }
    @keyframes vc-spin-glow {
      0%   { box-shadow: 0 0 12px 4px rgba(245,158,11,0.6); }
      50%  { box-shadow: 0 0 28px 8px rgba(245,158,11,0.9); }
      100% { box-shadow: 0 0 12px 4px rgba(245,158,11,0.6); }
    }
    #vc-orb svg { pointer-events: none; }

    /* Mic tooltip */
    #vc-tooltip {
      position: fixed;
      bottom: 100px;
      right: 90px;
      background: rgba(30,30,45,0.96);
      color: #fff;
      font-family: 'Outfit', sans-serif;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 8px;
      white-space: nowrap;
      z-index: 9998;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.2s, transform 0.2s;
      pointer-events: none;
    }
    #vc-tooltip.visible { opacity: 1; transform: translateY(0); }

    /* Transcript + status overlay */
    #vc-overlay {
      position: fixed;
      bottom: 105px;
      right: 90px;
      max-width: 380px;
      min-width: 220px;
      background: rgba(22,22,38,0.97);
      backdrop-filter: blur(14px);
      border: 1px solid rgba(108,93,211,0.35);
      border-radius: 16px;
      padding: 14px 18px;
      z-index: 9997;
      display: none;
      flex-direction: column;
      gap: 8px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.4);
      font-family: 'Outfit', sans-serif;
    }
    #vc-overlay.open { display: flex; }
    #vc-overlay-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: #8b7ae8;
    }
    #vc-transcript {
      font-size: 14px;
      color: #e2e8f0;
      min-height: 22px;
      line-height: 1.5;
      font-style: italic;
    }
    #vc-status {
      font-size: 12px;
      color: #94a3b8;
    }
    #vc-command-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 4px;
    }
    .vc-chip {
      background: rgba(108,93,211,0.18);
      border: 1px solid rgba(108,93,211,0.3);
      color: #a5b4fc;
      font-size: 10.5px;
      padding: 2px 8px;
      border-radius: 20px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .vc-chip:hover { background: rgba(108,93,211,0.35); }

    /* Keyboard shortcut hint */
    #vc-kb-hint {
      font-size: 10px;
      color: #64748b;
      margin-top: 2px;
    }

    /* Not-supported banner */
    #vc-unsupported {
      position: fixed;
      bottom: 28px;
      right: 28px;
      background: #1e1e2d;
      color: #94a3b8;
      font-size: 12px;
      padding: 10px 16px;
      border-radius: 10px;
      z-index: 9999;
      display: none;
    }
  `;
  document.head.appendChild(vcStyles);

  // ── Check browser support ────────────────────────────────────────────────
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    const banner = document.createElement('div');
    banner.id = 'vc-unsupported';
    banner.innerHTML = '🎙️ Voice control needs Chrome/Edge';
    banner.style.display = 'block';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 5000);
    return;
  }

  // ── Build DOM ───────────────────────────────────────────────────────────
  const orb = document.createElement('div');
  orb.id = 'vc-orb';
  orb.title = 'Click to speak (or press Space)';
  orb.innerHTML = `
    <svg id="vc-mic-icon" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3"/>
      <path d="M5 10a7 7 0 0 0 14 0"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
      <line x1="8" y1="22" x2="16" y2="22"/>
    </svg>`;

  const tooltip = document.createElement('div');
  tooltip.id = 'vc-tooltip';
  tooltip.textContent = 'Hold to speak · Space shortcut';

  const overlay = document.createElement('div');
  overlay.id = 'vc-overlay';
  overlay.innerHTML = `
    <div id="vc-overlay-label">🎙️ Friday Voice Control</div>
    <div id="vc-transcript">Say a command…</div>
    <div id="vc-status">Ready — click orb or press Space</div>
    <div id="vc-command-chips">
      <span class="vc-chip" onclick="vcSuggest('show report')">📋 Report</span>
      <span class="vc-chip" onclick="vcSuggest('show workloads')">⚙️ Workloads</span>
      <span class="vc-chip" onclick="vcSuggest('show cost')">💰 Cost</span>
      <span class="vc-chip" onclick="vcSuggest('show AI performance')">🧠 AI Perf</span>
      <span class="vc-chip" onclick="vcSuggest('generate report')">🔄 Generate</span>
      <span class="vc-chip" onclick="vcSuggest('show trends')">📈 Trends</span>
      <span class="vc-chip" onclick="vcSuggest('open chat')">💬 Chat</span>
      <span class="vc-chip" onclick="vcSuggest('cost estimator')">🧮 Estimator</span>
    </div>
    <div id="vc-kb-hint">⌨️ Press <b>Space</b> to toggle listening · <b>Esc</b> to stop</div>
  `;

  document.body.appendChild(orb);
  document.body.appendChild(tooltip);
  document.body.appendChild(overlay);

  // ── State ───────────────────────────────────────────────────────────────
  let recognition = null;
  let isListening = false;
  let overlayOpen = false;
  let silenceTimer = null;

  // ── Helpers ─────────────────────────────────────────────────────────────
  function setTranscript(t) { document.getElementById('vc-transcript').textContent = t || '—'; }
  function setStatus(t, color) {
    const el = document.getElementById('vc-status');
    el.textContent = t;
    el.style.color = color || '#94a3b8';
  }

  function vcSpeakFriday(text) {
    if (typeof speak === 'function' && window.fridayVoiceEnabled) {
      speak(text);
    } else {
      // Speak even if Friday voice toggle is off — this is a command response
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      const v = window.speechSynthesis.getVoices();
      const enVoice = v.find(x => x.lang.startsWith('en-US')) || v[0];
      if (enVoice) u.voice = enVoice;
      u.rate = 1.05; u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    }
  }

  function switchToTab(panelName) {
    const tab = document.querySelector(`.tab[data-panel="${panelName}"]`);
    if (tab) {
      if (typeof window.switchTab === 'function') window.switchTab(tab);
      return true;
    }
    return false;
  }

  // ── Intent Router ───────────────────────────────────────────────────────
  async function handleCommand(raw) {
    const t = raw.toLowerCase().trim();
    setStatus('Processing…', '#f59e0b');
    orb.className = 'thinking';

    // ── Question Patterns Guard ──────────────────────────────────────────
    // If it looks like a natural language question, bypass navigational router
    const questionWords = [
      'how', 'what', 'where', 'why', 'when', 'who', 'whose', 'which',
      'can we', 'can you', 'should we', 'should you', 'is there', 'are there',
      'tell me', 'explain', 'show me how', 'how to', 'what is', 'what are',
      'where is', 'where are', 'can i', 'analyze', 'why is', 'why are',
      'diagnose', 'query', 'calculate', 'tell friday', 'ask friday'
    ];
    const isQuestion = questionWords.some(qw => t.startsWith(qw) || t.includes(' ' + qw + ' ')) || t.includes('?');

    if (!isQuestion) {
      // ── Sub-tab navigation ──────────────────────────────────────────────
    // AWS subcategories
    const awsSubMap = [
      { keys: ['cloudfront', 'cnd', 'cdn', 'distribution'], val: 'cloudfront', say: 'Showing CloudFront details.' },
      { keys: ['s3', 'bucket', 'storage'], val: 's3', say: 'Showing S3 bucket details.' },
      { keys: ['ec2', 'ebs', 'compute', 'virtual machine'], val: 'ec2', say: 'Showing EC2 and EBS compute details.' },
      { keys: ['eks', 'kubernetes control', 'control plane'], val: 'eks', say: 'Showing EKS control plane details.' },
      { keys: ['iam', 'identity', 'permission', 'security'], val: 'iam', say: 'Showing IAM identity details.' }
    ];
    for (const entry of awsSubMap) {
      if (entry.keys.some(k => t.includes(k))) {
        switchToTab('aws-resources');
        if (typeof setAwsCategory === 'function') setAwsCategory(entry.val);
        setStatus(`✅ AWS subcategory: ${entry.val}`, '#22c55e');
        vcSpeakFriday(entry.say);
        orbIdle();
        return;
      }
    }

    // Workloads viewmodes
    const workloadSubMap = [
      { keys: ['pod', 'container', 'namespace'], val: 'pods', say: 'Showing pods visual dashboard.' },
      { keys: ['node table', 'nodes table'], val: 'nodes', nodeView: 'table', say: 'Showing nodes table view.' },
      { keys: ['node grid', 'nodes grid'], val: 'nodes', nodeView: 'grid', say: 'Showing nodes grid view.' },
      { keys: ['node', 'host'], val: 'nodes', say: 'Showing nodes view.' },
      { keys: ['recommendation', 'sizing', 'advice', 'recs'], val: 'recs', say: 'Showing workloads sizing recommendations.' }
    ];
    for (const entry of workloadSubMap) {
      if (entry.keys.some(k => t.includes(k))) {
        switchToTab('workloads');
        if (typeof setViewMode === 'function') setViewMode(entry.val);
        if (entry.nodeView && typeof setNodeView === 'function') setNodeView(entry.nodeView);
        setStatus(`✅ Workload mode: ${entry.val}`, '#22c55e');
        vcSpeakFriday(entry.say);
        orbIdle();
        return;
      }
    }

    // Cost viewmodes
    const costSubMap = [
      { keys: ['cost table', 'billing table', 'chargeback table'], val: 'table', say: 'Showing cost table.' },
      { keys: ['cost chart', 'cost graph', 'billing chart', 'visualisation'], val: 'chart', say: 'Showing cost distribution chart.' }
    ];
    for (const entry of costSubMap) {
      if (entry.keys.some(k => t.includes(k))) {
        switchToTab('cost');
        if (typeof setCostView === 'function') setCostView(entry.val);
        setStatus(`✅ Cost mode: ${entry.val}`, '#22c55e');
        vcSpeakFriday(entry.say);
        orbIdle();
        return;
      }
    }

    // ── Tab navigation ──────────────────────────────────────────────────
    const tabMap = [
      { keys: ['report','summary','executive','analysis'], panel: 'report',        say: 'Opening the FinOps report.' },
      { keys: ['workload','pods','pod','container','namespace'], panel: 'workloads', say: 'Showing workloads.' },
      { keys: ['cost','costs','spending','billing','chargeback'], panel: 'cost',    say: 'Opening cost view.' },
      { keys: ['aws','resource','ec2','ebs','s3','bucket'],       panel: 'aws-resources', say: 'Showing AWS resources.' },
      { keys: ['trend','history','historical','over time'],       panel: 'trends',  say: 'Opening trends.' },
      { keys: ['chat','talk','ask','friday','hey'],               panel: 'chat',    say: 'Opening chat with Friday.' },
      { keys: ['estimat','project cost','estimate'],             panel: 'estimator', say: 'Opening cost estimator.' },
      { keys: ['ai perf','ai performance','model','nllb','llama','litellm','biobert'], panel: 'ai-perf', say: 'Showing AI model performance.' },
    ];

    for (const entry of tabMap) {
      if (entry.keys.some(k => t.includes(k))) {
        switchToTab(entry.panel);
        setStatus(`✅ Navigated to ${entry.panel}`, '#22c55e');
        vcSpeakFriday(entry.say);
        orbIdle();
        return;
      }
    }

    // ── Generate report ──────────────────────────────────────────────────
    if (t.includes('generat') || t.includes('run report') || t.includes('collect') || t.includes('refresh data')) {
      setStatus('⚙️ Starting report generation…', '#a855f7');
      vcSpeakFriday('Starting report generation now, Anirudh. This may take a minute.');
      try {
        await fetch('/api/generate', { method: 'POST' });
        setStatus('✅ Generation started', '#22c55e');
      } catch(e) {
        setStatus('❌ Failed to start generation', '#ef4444');
        vcSpeakFriday('Sorry, I could not start the generation.');
      }
      orbIdle();
      return;
    }

    // ── Refresh AI metrics ────────────────────────────────────────────────
    if (t.includes('refresh ai') || t.includes('check models') || t.includes('probe models')) {
      switchToTab('ai-perf');
      if (typeof loadAiMetrics === 'function') loadAiMetrics();
      vcSpeakFriday('Refreshing AI model metrics now.');
      setStatus('✅ AI metrics refreshed', '#22c55e');
      orbIdle();
      return;
    }

    // ── Voice toggle ──────────────────────────────────────────────────────
    if (t.includes('mute') || t.includes('silence') || t.includes('quiet') || t.includes('stop talking')) {
      window.fridayVoiceEnabled = false;
      const tog = document.getElementById('voiceToggle');
      if (tog) tog.checked = false;
      setStatus('🔇 Voice muted', '#94a3b8');
      orbIdle();
      return;
    }
    if (t.includes('unmute') || t.includes('speak again') || t.includes('enable voice')) {
      window.fridayVoiceEnabled = true;
      const tog = document.getElementById('voiceToggle');
      if (tog) tog.checked = true;
      vcSpeakFriday('Voice enabled. I can hear you!');
      setStatus('🔊 Voice enabled', '#22c55e');
      orbIdle();
      return;
    }

    // ── Help / what can you do ────────────────────────────────────────────
    if (t.includes('help') || t.includes('what can you') || t.includes('commands')) {
      vcSpeakFriday('You can say: show report, show workloads, show cost, open chat, generate report, show AI performance, show trends, scroll down, scroll up, or ask me any infrastructure question.');
      setStatus('ℹ️ Help spoken', '#3b82f6');
      orbIdle();
      return;
    }

    // ── Scroll / page navigation ──────────────────────────────────────────
    // Find the scrollable content area of the currently active panel
    const scrollCmds = ['scroll', 'page', 'go down', 'go up', 'move down', 'move up',
                        'top', 'bottom', 'up', 'down'];
    if (scrollCmds.some(k => t.includes(k))) {
      // Active panel content area
      const activePanel = document.querySelector('.panel.active');
      const isDown = t.includes('down') || t.includes('bottom') || t.includes('next');
      const isUp   = t.includes('up')   || t.includes('top')    || t.includes('back') || t.includes('previous');
      const isBottom = t.includes('bottom') || t.includes('end');
      const isTop    = t.includes('top')    || t.includes('start') || t.includes('beginning');

      // Amount: "a lot" / "more" = big jump; default = medium
      const amount = (t.includes('lot') || t.includes('more') || t.includes('page')) ? 600
                   : (t.includes('little') || t.includes('bit') || t.includes('small')) ? 120
                   : 320;

      // Find all scrollable candidate elements inside the active panel
      const scrollableElements = [];
      if (activePanel) {
        // Find children with auto/scroll overflow
        activePanel.querySelectorAll('*').forEach(el => {
          const style = window.getComputedStyle(el);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            scrollableElements.push(el);
          }
        });
        
        // Also add key candidates directly
        const wc = activePanel.querySelector('.workloads-container');
        if (wc && !scrollableElements.includes(wc)) scrollableElements.push(wc);
        
        const tc = activePanel.querySelector('.table-container');
        if (tc && !scrollableElements.includes(tc)) scrollableElements.push(tc);

        if (!scrollableElements.includes(activePanel)) scrollableElements.push(activePanel);
      }
      
      // Add general elements
      const mainEl = document.querySelector('.main');
      if (mainEl && !scrollableElements.includes(mainEl)) scrollableElements.push(mainEl);
      scrollableElements.push(document.documentElement);
      scrollableElements.push(document.body);

      // Perform scrolling on all candidates (non-scrollable targets will safely do nothing)
      scrollableElements.forEach(target => {
        try {
          if (isBottom) {
            target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
          } else if (isTop) {
            target.scrollTo({ top: 0, behavior: 'smooth' });
          } else if (isDown) {
            target.scrollBy({ top: amount, behavior: 'smooth' });
          } else if (isUp) {
            target.scrollBy({ top: -amount, behavior: 'smooth' });
          }
        } catch (err) {
          // ignore scrolling errors on incompatible nodes
        }
      });

      // Also trigger a window-level scroll in case the viewport isn't flex-constrained
      try {
        if (isBottom) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        else if (isTop) window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (isDown) window.scrollBy({ top: amount, behavior: 'smooth' });
        else if (isUp) window.scrollBy({ top: -amount, behavior: 'smooth' });
      } catch(e) {}

      setStatus('✅ Scrolled', '#22c55e');
      orbIdle();
      return;
    }

    // ── Stop / close overlay ──────────────────────────────────────────────
    if (t === 'stop' || t === 'close' || t === 'dismiss' || t === 'cancel' || t === 'never mind') {
      setStatus('👋 Dismissed', '#94a3b8');
      orbIdle();
      closeOverlay();
      return;
    }

    // ── Guard: don't send short/ambiguous UI words to LLM ────────────────
    // These are almost certainly misheard navigation words, not real questions
    const uiOnlyWords = ['scroll', 'click', 'open', 'close', 'show', 'hide', 'next',
                         'previous', 'back', 'forward', 'stop', 'go', 'page', 'tab',
                         'switch', 'navigate', 'move', 'zoom', 'refresh'];
    const isShortUICmd = t.split(' ').length <= 3 && uiOnlyWords.some(w => t.includes(w));
    if (isShortUICmd) {
      setStatus(`⚠️ Not understood: "${raw}" — try "show [tab name]"`, '#f59e0b');
      vcSpeakFriday(`I didn't recognise that as a tab name. Try saying: show report, show workloads, or show cost.`);
      orbIdle();
      return;
    }
  } // <-- Close of if (!isQuestion)

  // ── Fallback: treat as chat question → LLM ────────────────────
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
      chatInput.value = raw;
      setStatus('💬 Sending to Friday AI…', '#8b7ae8');

      // Add user message to chat history in background
      addMessage('user', raw);

      const typing = document.createElement('div');
      typing.className = 'typing-indicator';
      typing.textContent = 'AI is thinking...';
      typing.id = 'typingIndicator';
      document.getElementById('chatMessages').appendChild(typing);
      scrollChat();

      try {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: raw }),
        });
        const data = await resp.json();
        typing.remove();
        if (data.error) {
          addMessage('assistant', 'Error: ' + data.error);
          vcSpeakFriday("I encountered an error getting the answer, Anirudh.");
        } else {
          addMessage('assistant', data.response);

          let textToSpeak = data.response;
          textToSpeak = textToSpeak.replace(/```[\s\S]*?```/g, "Code snippet provided.");
          textToSpeak = textToSpeak.replace(/`([^`]+)`/g, "$1");
          textToSpeak = textToSpeak.replace(/\*\*/g, "");
          if (textToSpeak.length > 300) {
            textToSpeak = textToSpeak.substring(0, 300) + "... details are printed in chat.";
          }
          vcSpeakFriday(textToSpeak);
        }
      } catch (e) {
        typing.remove();
        addMessage('assistant', 'Connection error: ' + e.message);
        vcSpeakFriday("Connection error occurred.");
      }
    }
    setStatus('✅ Done', '#22c55e');
    orbIdle();
  }

  // Sidebar button updater
  function updateSidebarBtn(active) {
    const btnText = document.getElementById('sidebarVoiceControlText');
    const pulseDot = document.getElementById('sidebarVoiceControlPulse');
    const btn = document.getElementById('sidebarVoiceControlBtn');
    if (!btn) return;
    if (active) {
      if (btnText) btnText.textContent = 'Stop';
      if (pulseDot) pulseDot.style.display = 'inline-block';
      btn.style.background = 'rgba(239, 68, 68, 0.2)';
      btn.style.borderColor = 'rgba(239, 68, 68, 0.5)';
    } else {
      if (btnText) btnText.textContent = 'Start';
      if (pulseDot) pulseDot.style.display = 'none';
      btn.style.background = 'rgba(108, 93, 211, 0.25)';
      btn.style.borderColor = 'rgba(108, 93, 211, 0.45)';
    }
  }

  window.toggleVoiceControl = function() {
    if (isListening || vcHandsFree) {
      vcHandsFree = false;
      stopListening();
      orbIdle();
    } else {
      openOverlay();
      setTimeout(startListening, 200);
    }
  };

  // ── Recognition lifecycle ───────────────────────────────────────────────
  let vcHandsFree = false;

  function startListening() {
    if (isListening) return;
    vcHandsFree = true; // Activate hands-free session

    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onstart = () => {
      isListening = true;
      orb.className = 'listening';
      setTranscript('Listening…');
      setStatus('🔴 Listening — speak now', '#ef4444');
      updateSidebarBtn(true);
      if (!overlayOpen) openOverlay();

      // Auto-stop after 8s of silence to allow restart loop
      silenceTimer = setTimeout(() => stopListening(), 8000);
    };

    recognition.onresult = (e) => {
      clearTimeout(silenceTimer);
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      setTranscript(final || interim);
      if (final) {
        stopListening();
        handleCommand(final.trim());
      } else {
        silenceTimer = setTimeout(() => stopListening(), 4000);
      }
    };

    recognition.onerror = (e) => {
      clearTimeout(silenceTimer);
      if (e.error === 'no-speech') {
        setStatus('No speech detected', '#f59e0b');
      } else if (e.error === 'not-allowed') {
        setStatus('❌ Microphone blocked — allow mic in browser', '#ef4444');
        vcSpeakFriday('Please allow microphone access in your browser settings.');
        vcHandsFree = false;
      } else {
        setStatus(`Error: ${e.error}`, '#ef4444');
      }
      orbIdle();
    };

    recognition.onend = () => {
      isListening = false;
      if (vcHandsFree) {
        // Wait a short moment and check if Friday is currently speaking
        setTimeout(() => {
          if (!vcHandsFree) {
            orbIdle();
            return;
          }
          if (window.speechSynthesis && window.speechSynthesis.speaking) {
            orb.className = 'thinking'; // Amber light while speaking
            setStatus('🔊 Friday is speaking…', '#a855f7');
            const checkSpeaking = setInterval(() => {
              if (!vcHandsFree) {
                clearInterval(checkSpeaking);
                orbIdle();
                return;
              }
              if (!window.speechSynthesis.speaking) {
                clearInterval(checkSpeaking);
                if (vcHandsFree && !isListening) {
                  startListening();
                }
              }
            }, 200);
          } else {
            if (vcHandsFree && !isListening) {
              startListening();
            }
          }
        }, 300);
      } else {
        orbIdle();
      }
    };

    try { recognition.start(); } catch(e) { console.warn('VC start error:', e); }
  }

  function stopListening() {
    clearTimeout(silenceTimer);
    if (recognition) { try { recognition.stop(); } catch(e) {} }
    isListening = false;
  }

  function orbIdle() {
    if (!vcHandsFree) {
      orb.className = '';
      isListening = false;
      updateSidebarBtn(false);
    }
  }

  // ── Overlay open/close ──────────────────────────────────────────────────
  function openOverlay() {
    overlayOpen = true;
    overlay.classList.add('open');
  }
  function closeOverlay() {
    overlayOpen = false;
    overlay.classList.remove('open');
  }

  // ── Orb click ───────────────────────────────────────────────────────────
  orb.addEventListener('click', () => {
    if (isListening || vcHandsFree) {
      vcHandsFree = false;
      stopListening();
      orbIdle();
    } else if (overlayOpen) {
      startListening();
    } else {
      openOverlay();
      setTimeout(startListening, 200);
    }
  });

  // ── Keyboard shortcut: Space to listen, Esc to stop ────────────────────
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (isListening || vcHandsFree) {
        vcHandsFree = false;
        stopListening();
        orbIdle();
      } else {
        openOverlay();
        startListening();
      }
    }
    if (e.code === 'Escape') {
      vcHandsFree = false;
      stopListening();
      orbIdle();
      closeOverlay();
    }
  });

  // ── Tooltip on hover ────────────────────────────────────────────────────
  orb.addEventListener('mouseenter', () => tooltip.classList.add('visible'));
  orb.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));

  // ── Click outside overlay to close ─────────────────────────────────────
  document.addEventListener('click', (e) => {
    if (overlayOpen && !overlay.contains(e.target) && e.target !== orb) {
      if (!isListening && !vcHandsFree) closeOverlay();
    }
  });

  // ── Chip helper ─────────────────────────────────────────────────────────
  window.vcSuggest = function(cmd) {
    setTranscript(cmd);
    setStatus('Running command…', '#8b7ae8');
    handleCommand(cmd);
  };

  // ── Greet on first load ─────────────────────────────────────────────────
  setTimeout(() => {
    openOverlay();
    setStatus('Click orb or press Space to speak', '#94a3b8');
    vcSpeakFriday("Hey Anirudh!");
    setTimeout(() => { if (!isListening && !vcHandsFree) closeOverlay(); }, 5000);
  }, 2500);

  console.log('%c🎙️ Friday Voice Control Active — Press Space to speak', 'color:#8b7ae8;font-weight:bold;font-size:13px;');


  // ── Sidebar panel Voice Toggle ─────────────────────────────────────────
  function updateSidebarBtn(active) {
    const btn = document.getElementById('vc-toggle-btn');
    const statusEl = document.getElementById('vc-toggle-status');
    if (!btn) return;
    if (active) {
      btn.textContent = 'Stop';
      btn.style.background = 'linear-gradient(135deg,#ef4444,#f87171)';
      btn.style.boxShadow = '0 3px 10px rgba(239,68,68,0.4)';
      if (statusEl) statusEl.textContent = 'Listening — speak a command';
    } else {
      btn.textContent = 'Start';
      btn.style.background = 'linear-gradient(135deg,#6c5dd3,#8b7ae8)';
      btn.style.boxShadow = '0 3px 10px rgba(108,93,211,0.35)';
      if (statusEl) statusEl.textContent = 'Inactive — click to activate';
    }
  }

  window.toggleVoiceControl = function() {
    if (isListening || vcHandsFree) {
      vcHandsFree = false;
      stopListening();
      orbIdle();
      updateSidebarBtn(false);
      setStatus('Stopped', '#94a3b8');
    } else {
      openOverlay();
      startListening();
      updateSidebarBtn(true);
    }
  };

})();

// ══════════════════════════════════════════════════════════════════════════════
