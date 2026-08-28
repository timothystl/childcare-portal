function printPartB(){
  document.body.classList.add('printing-partb');
  window.print();
  document.body.classList.remove('printing-partb');
}
document.getElementById('printPartBBtn')?.addEventListener('click', printPartB);
// sidebar active highlight
const sections=document.querySelectorAll('section[id]');
const navLinks=document.querySelectorAll('.nav-link');
window.addEventListener('scroll',()=>{
  let cur='';
  sections.forEach(s=>{if(s.getBoundingClientRect().top<=120)cur=s.id;});
  navLinks.forEach(l=>{l.classList.toggle('active',l.dataset.sec===cur);});
},{passive:true});
