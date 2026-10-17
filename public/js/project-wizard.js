import { PROJECT_TRACKS, PROJECT_PALETTES, validateProjectRequest } from './agency-model.js';
import { submitProjectRequest } from './project-request-data.js';
import { escapeHTML as h } from './sanitize.js';

export function createProjectWizard({getIdentity}) {
    const $=id=>document.getElementById(id);
    const dialog=$('projectWizardModal'), form=$('projectWizardForm');
    let step=0, category='', palette='', bound=null, identityKey='', busy=false, sent=false, lastFocus=null;
    const selected=name=>form.querySelector(`input[name="${name}"]:checked`)?.value || '';
    const features=()=>[...form.querySelectorAll('input[name="pw-feature"]:checked')].map(input=>input.value);
    $('pw-categories').innerHTML=Object.entries(PROJECT_TRACKS).map(([key,track])=>`<label class="pw-category"><input type="radio" name="pw-category" value="${key}"><span class="pw-category-top"><span class="pw-category-icon" aria-hidden="true">${track.icon}</span><span class="pw-radio-mark" aria-hidden="true"></span></span><strong>${h(track.label)}</strong><small>${h(track.description)}</small></label>`).join('');
    $('pw-palettes').innerHTML=PROJECT_PALETTES.map(item=>`<label class="pw-palette"><input type="radio" name="pw-palette" value="${h(item.name)}"><span class="pw-swatches" aria-hidden="true">${item.colors.map(color=>`<i style="background:${color}"></i>`).join('')}</span><strong>${h(item.name)}</strong></label>`).join('');
    function setCategory(value) {
        if (!Object.hasOwn(PROJECT_TRACKS,value) || category===value) return;
        category=value;
        for (const input of form.querySelectorAll('input[name="pw-category"]')) input.checked=input.value===category;
        const track=PROJECT_TRACKS[category];
        $('pw-track-label').textContent=track.label;
        $('pw-subtypes').innerHTML=track.types.map(type=>`<label class="pw-pill"><input type="radio" name="pw-subtype" value="${h(type)}"><span>${h(type)}</span></label>`).join('');
        $('pw-features').innerHTML=track.features.map(feature=>`<label class="pw-feature"><input type="checkbox" name="pw-feature" value="${h(feature)}"><span>${h(feature)}</span></label>`).join('');
        $('pw-profession-label').textContent=track.professionLabel+' *';
        $('pw-purpose-label').textContent=track.purposeLabel+' *';
        $('pw-purpose').placeholder=track.purposeHint;
        $('pw-scale-label').textContent=category==='websites'?'Estimated products / pages *':category==='applications'?'Estimated initial users / team size *':'Estimated pages / workflows / deliverables *';
        // Answers belonging to the previous track are not silently submitted.
        for(const id of ['pw-profession','pw-purpose','pw-scale']) $(id).value='';
    }
    function refreshIdentity() {
        const identity=getIdentity();
        const key=identity?`${identity.uid || 'contact'}:${identity.clientEmail}`:'guest';
        if(key!==identityKey){
            for(const [id,field] of [['pw-client-name','clientName'],['pw-client-email','clientEmail'],['pw-company','company']]) $(id).value=identity?.[field] || '';
            $('pw-phone').value='';
            identityKey=key;
        }
        bound=identity?.uid?identity:null;
        if(bound)for(const [id,field] of [['pw-client-name','clientName'],['pw-client-email','clientEmail'],['pw-company','company']]) $(id).value=bound[field] || '';
        for(const id of ['pw-client-name','pw-client-email','pw-company']) $(id).readOnly=Boolean(bound);
        $('pw-account-badge').hidden=!identity;
        $('pw-account-badge').textContent=identity?`Submitting as ${identity.clientName} (${identity.clientEmail})${bound?' · Account linked':' · Store contact'}`:'';
    }
    function values() {
        const colors=[palette,$('pw-custom-colors').value.trim()].filter(Boolean).join(' · ');
        return {uid:bound?.uid || null,clientName:bound?.clientName || $('pw-client-name').value,clientEmail:bound?.clientEmail || $('pw-client-email').value,clientPhone:$('pw-phone').value,company:bound?.company ?? $('pw-company').value,
            category,subType:selected('pw-subtype'),profession:$('pw-profession').value,productsOrServices:$('pw-purpose').value,estimatedScale:$('pw-scale').value,selectedFeatures:features(),projectName:$('pw-project-name').value,preferredColors:colors,aestheticStyle:$('pw-style').value,timeline:$('pw-timeline').value,notes:$('pw-notes').value};
    }
    function renderReview() {
        const data=values();
        const rows=[['Solution',PROJECT_TRACKS[category]?.label],['Type',data.subType],['Business / audience',data.profession],['Purpose / deliverables',data.productsOrServices],['Estimated scale',data.estimatedScale],['Features',data.selectedFeatures.join(' · ') || 'To be discussed'],['Project',data.projectName],['Colors',data.preferredColors],['Style',data.aestheticStyle],['Timeline',data.timeline],['Notes',data.notes || '—']];
        $('pw-review').innerHTML=rows.map(([label,value])=>`<div><dt>${h(label)}</dt><dd>${h(value || '—')}</dd></div>`).join('');
    }
    function showStep(next) {
        step=next;
        document.querySelectorAll('[data-pw-step]').forEach(el=>{el.hidden=Number(el.dataset.pwStep)!==step;});
        document.querySelectorAll('[data-pw-progress]').forEach(el=>{
            const n=Number(el.dataset.pwProgress);el.classList.toggle('is-current',n===step);el.classList.toggle('is-complete',n<step);
            if(n===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');
        });
        $('pw-step-count').textContent=`STEP ${String(step+1).padStart(2,'0')} / 04`;
        $('pw-back').hidden=step===0;
        $('pw-next').textContent=step===3?'Send project brief ↗':'Continue →';
        $('pw-error').hidden=true;
        if(step===3){refreshIdentity();renderReview();}
        const title=['pw-title','pw-scope-title','pw-identity-title','pw-review-title'][step];$(title).focus();
        dialog.scrollTop=0;
    }
    function validateStep() {
        if(step===0 && !category)throw new Error('Choose the solution that fits your idea.');
        if(step===1){
            if(!selected('pw-subtype'))throw new Error('Choose a project type.');
            for(const [id,label] of [['pw-profession','your business / industry'],['pw-purpose','the core purpose / deliverables'],['pw-scale','an estimated scale']])if(!$(id).value.trim()){$(id).focus();throw new Error(`Tell us ${label}.`);}
        }
        if(step===2){
            for(const [id,label] of [['pw-project-name','a project name / domain'],['pw-style','a visual style'],['pw-timeline','a launch timeline']])if(!$(id).value.trim()){$(id).focus();throw new Error(`Choose ${label}.`);}
            if(!palette && !$('pw-custom-colors').value.trim())throw new Error('Choose a color direction or describe your own.');
        }
    }
    function close(){if(busy)return;dialog.close();document.body.classList.remove('project-wizard-open');lastFocus?.focus();}
    function reset(){form.reset();category=palette='';identityKey='';sent=false;bound=null;$('pw-success').hidden=true;form.hidden=false;showStep(0);refreshIdentity();}
    function open(preselected='') {
        if(busy)return;
        lastFocus=document.activeElement;
        if(sent)reset();
        if(preselected && Object.hasOwn(PROJECT_TRACKS,preselected)){setCategory(preselected);showStep(0);}
        refreshIdentity();if(!dialog.open)dialog.showModal();document.body.classList.add('project-wizard-open');showStep(step);
    }
    form.addEventListener('change',event=>{
        if(busy)return;
        if(event.target.name==='pw-category')setCategory(event.target.value);
        if(event.target.name==='pw-palette')palette=event.target.value;
    });
    form.addEventListener('submit',async event=>{
        event.preventDefault();if(busy||sent)return;
        $('pw-error').hidden=true;
        try{
            validateStep();
            if(step<3){showStep(step+1);return;}
            refreshIdentity();
            const input=validateProjectRequest(values());
            busy=true;dialog.setAttribute('aria-busy','true');$('pw-next').disabled=true;$('pw-next').textContent='Sending your brief…';$('pw-back').disabled=true;$('pw-close').disabled=true;
            const result=await submitProjectRequest(input);
            sent=true;form.hidden=true;$('pw-success').hidden=false;$('pw-reference').textContent=`Request reference: ${result.id}`;$('pw-success-title').focus();
        }catch(error){$('pw-error').textContent=error.code==='permission-denied'?'We could not save your request. Please contact SQySystems or try again later.':error.message || 'Your request could not be sent. Please try again.';$('pw-error').hidden=false;}
        finally{busy=false;dialog.removeAttribute('aria-busy');$('pw-next').disabled=false;$('pw-back').disabled=false;$('pw-close').disabled=false;if(!sent)$('pw-next').textContent=step===3?'Send project brief ↗':'Continue →';}
    });
    $('pw-back').addEventListener('click',()=>{if(!busy&&step>0)showStep(step-1);});
    $('pw-close').addEventListener('click',close);$('pw-done').addEventListener('click',close);$('pw-another').addEventListener('click',reset);
    $('pw-brand').addEventListener('click',event=>{event.preventDefault();close();});
    dialog.addEventListener('close',()=>{document.body.classList.remove('project-wizard-open');lastFocus?.focus();});
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    document.addEventListener('click',event=>{const button=event.target.closest('[data-start-project]');if(button){event.preventDefault();open(button.dataset.startProject);}});
    window.addEventListener('pagehide',()=>{if(dialog.open)dialog.close();form.reset();});
    refreshIdentity();showStep(0);
    return {open,refreshIdentity};
}
