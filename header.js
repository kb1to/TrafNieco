document.addEventListener("DOMContentLoaded", () => {
    fetch("header.html")
        .then(res => res.text())
        .then(data => {
            const header = document.getElementById("header");
            if(header) {
                header.innerHTML = data;
            }

            window.addEventListener("scroll", () =>{
                if(window.scrollY > 100){
                    header.classList.add("visible");
                }
                else
                {
                    header.classList.remove("visible")
                }
                
            })
        })
        .catch(err => console.error("header not loaded"));
});